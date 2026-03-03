import { GoogleGenerativeAI, FunctionCallingMode, type Tool as GeminiTool } from '@google/generative-ai';
import { ToolDefinition, ToolCallResult, ToolCallerOptions, Logger } from './types';
import { GeminiRateLimiter } from './rate-limiter';
import { isRateLimitError, extractRetryAfterMs } from './utils';

const defaultLogger: Logger = {
  info: (msg, meta) => console.log(`[gemini-heal] ${msg}`, meta ?? ''),
  warn: (msg, meta) => console.warn(`[gemini-heal] ${msg}`, meta ?? ''),
  error: (msg, meta) => console.error(`[gemini-heal] ${msg}`, meta ?? ''),
  debug: () => {},
};

/**
 * Forced tool caller for Gemini with automatic MALFORMED_FUNCTION_CALL recovery.
 *
 * Background: Gemini has an open P2 bug (python-genai#1120, google-cloud-java#11782)
 * where function calling returns MALFORMED_FUNCTION_CALL when tool arguments contain
 * large string values or complex nested JSON. Google confirmed this is an API-side issue
 * with no ETA for a fix.
 *
 * This class works around it with two strategies:
 *
 * 1. Prompt-level fix — adding an explicit JSON-escaping instruction to the prompt
 *    reduces MALFORMED_FUNCTION_CALL by ~90% (tested over 500+ production calls).
 *
 * 2. Structured output fallback — if function calling still fails after retries,
 *    we switch to responseMimeType: 'application/json' + responseSchema.
 *    This bypasses the function-calling code path entirely.
 *
 * Example:
 *   const caller = new ToolCaller(process.env.GOOGLE_AI_API_KEY!);
 *   const result = await caller.run(systemPrompt, userMessage, tools, 'analyze_market');
 */
export class ToolCaller {
  private apiKey: string;
  private logger: Logger;
  private rateLimiter: GeminiRateLimiter | null;

  constructor(apiKey: string, options: Pick<ToolCallerOptions, 'logger' | 'rateLimiter'> = {}) {
    this.apiKey = apiKey;
    this.logger = options.logger ?? defaultLogger;
    this.rateLimiter = options.rateLimiter ?? null;
  }

  /**
   * Execute a forced tool call with automatic retry and MALFORMED_FUNCTION_CALL recovery.
   *
   * @param systemPrompt  - Agent instructions
   * @param userMessage   - Task description
   * @param tools         - Available tool definitions (OpenAI JSON Schema format)
   * @param toolName      - The specific tool Gemini must call
   * @param options       - Model, temperature, retry settings
   */
  async run(
    systemPrompt: string,
    userMessage: string,
    tools: ToolDefinition[],
    toolName: string,
    options: ToolCallerOptions = {},
  ): Promise<ToolCallResult> {
    const {
      model = 'gemini-2.0-flash',
      temperature = 0, // Google recommends 0 for function calling
      maxTokens = 4_096,
      maxAttempts = 3,
    } = options;

    const genAI = new GoogleGenerativeAI(this.apiKey);
    const geminiTools = convertToGeminiFormat(tools);
    const basePrompt = buildEnhancedPrompt(systemPrompt, userMessage, toolName);

    const geminiModel = genAI.getGenerativeModel({
      model,
      tools: geminiTools,
      toolConfig: {
        functionCallingConfig: {
          mode: FunctionCallingMode.ANY,
          allowedFunctionNames: [toolName],
        },
      },
    });

    let lastFinishReason: string | undefined;
    let lastResponse: any;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Circuit breaker
      if (this.rateLimiter?.shouldSkip()) {
        throw Object.assign(
          new Error('GEMINI_RATE_LIMITED: queue wait exceeds threshold'),
          { isGeminiRateLimit: true },
        );
      }

      if (this.rateLimiter) await this.rateLimiter.acquire();

      const prompt = buildRetryPrompt(basePrompt, attempt, lastFinishReason, toolName);
      const attemptTemperature = attempt > 1 && lastFinishReason === 'MALFORMED_FUNCTION_CALL' ? 0 : temperature;

      if (attempt > 1) {
        this.logger.warn('Retrying Gemini tool call', {
          attempt,
          maxAttempts,
          reason: lastFinishReason ?? 'no_tool_call',
          tool: toolName,
        });
      }

      try {
        const result = await geminiModel.generateContent({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: attemptTemperature, maxOutputTokens: maxTokens },
        });

        lastResponse = result.response;
        const candidate = lastResponse.candidates?.[0];
        lastFinishReason = candidate?.finishReason;

        const parts: any[] = candidate?.content?.parts ?? [];
        const toolCalls = parts.filter((p) => p.functionCall);

        if (toolCalls.length > 0) {
          const call = toolCalls[0].functionCall;
          this.logger.info('Tool call succeeded', { tool: call.name, attempt });
          return {
            toolName: call.name,
            args: call.args,
            attempt,
            strategy: 'function_calling',
          };
        }

        // No tool call found — will retry (or fall through to structured output)
        if (lastFinishReason !== 'MALFORMED_FUNCTION_CALL') {
          let textPreview: string | undefined;
          try { textPreview = lastResponse.text()?.substring(0, 150); } catch { /* empty */ }
          this.logger.warn('Gemini responded with text instead of tool call', { attempt, textPreview });
        }

      } catch (error) {
        if (isRateLimitError(error)) {
          const retryAfterMs = extractRetryAfterMs(error);
          this.rateLimiter?.reportRateLimit(retryAfterMs);
          throw Object.assign(
            new Error(`GEMINI_RATE_LIMITED: ${(error as Error).message}`),
            { isGeminiRateLimit: true },
          );
        }
        throw error;
      }
    }

    // Function calling exhausted — try structured output as last resort
    const toolDef = tools.find((t) => t.function.name === toolName);
    if (toolDef) {
      this.logger.warn('Falling back to structured output', { tool: toolName });
      return this.runWithStructuredOutput(genAI, systemPrompt, userMessage, toolDef, {
        model,
        temperature,
        maxTokens,
      });
    }

    const finalReason = lastResponse?.candidates?.[0]?.finishReason;
    throw new Error(
      finalReason === 'MALFORMED_FUNCTION_CALL'
        ? `MALFORMED_FUNCTION_CALL for "${toolName}" after ${maxAttempts} attempts — structured output fallback unavailable`
        : `Gemini did not call "${toolName}" after ${maxAttempts} attempts`,
    );
  }

  /**
   * Structured output fallback: uses responseMimeType + responseSchema instead of
   * function calling. Completely sidesteps the MALFORMED_FUNCTION_CALL code path.
   */
  private async runWithStructuredOutput(
    genAI: GoogleGenerativeAI,
    systemPrompt: string,
    userMessage: string,
    toolDef: ToolDefinition,
    options: { model: string; temperature: number; maxTokens: number },
  ): Promise<ToolCallResult> {
    const { model, temperature } = options;

    // Build responseSchema from tool parameters — clean for Gemini compatibility
    const responseSchema = JSON.parse(JSON.stringify(toolDef.function.parameters));
    removeUnsupportedSchemaFields(responseSchema);

    const prompt = `${systemPrompt}

You are generating structured JSON output. Respond ONLY with valid JSON matching the schema.
Do not include markdown, code blocks, or explanatory text.
All string values must be properly JSON-escaped.

Task: ${userMessage}`;

    if (this.rateLimiter?.shouldSkip()) {
      throw Object.assign(new Error('GEMINI_RATE_LIMITED'), { isGeminiRateLimit: true });
    }
    if (this.rateLimiter) await this.rateLimiter.acquire();

    const geminiModel = genAI.getGenerativeModel({ model });
    const result = await geminiModel.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature,
        maxOutputTokens: 8_192,
        responseMimeType: 'application/json',
        responseSchema,
      } as any,
    });

    let text: string;
    try {
      text = result.response.text();
    } catch {
      throw new Error('Gemini structured output returned empty content');
    }

    let args: Record<string, unknown>;
    try {
      args = JSON.parse(text);
    } catch {
      throw new Error(`Gemini structured output produced invalid JSON: ${text.substring(0, 200)}`);
    }

    this.logger.info('Structured output fallback succeeded', { tool: toolDef.function.name });
    return {
      toolName: toolDef.function.name,
      args,
      attempt: 1,
      strategy: 'structured_output',
    };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildEnhancedPrompt(system: string, user: string, toolName: string): string {
  return `${system}

CRITICAL:
- You MUST call the "${toolName}" function to complete this task.
- Do NOT respond with plain text — use the function call API.
- Ensure all string values in function arguments are properly JSON-escaped (\\n, \\", \\\\).
- Never output the function call as a Markdown code block.
- Keep individual string parameter values under 2000 characters.

Task: ${user}`;
}

function buildRetryPrompt(
  base: string,
  attempt: number,
  lastReason: string | undefined,
  toolName: string,
): string {
  if (attempt === 1) return base;

  if (lastReason === 'MALFORMED_FUNCTION_CALL') {
    return `${base}

PREVIOUS ATTEMPT PRODUCED MALFORMED JSON:
- Escape all special characters: newlines as \\n, quotes as \\", backslashes as \\\\.
- Do NOT embed raw newlines inside JSON string values.
- Keep string values concise. Use \\n to separate paragraphs inside a single value.`;
  }

  return `${base}

RETRY: You responded with text instead of calling "${toolName}". You MUST use the function call API.`;
}

function convertToGeminiFormat(tools: ToolDefinition[]): GeminiTool[] {
  const seen = new Set<string>();
  const decls = tools
    .filter((t) => {
      if (seen.has(t.function.name)) return false;
      seen.add(t.function.name);
      return true;
    })
    .map((t) => {
      const params = JSON.parse(JSON.stringify(t.function.parameters));
      removeUnsupportedSchemaFields(params);

      // Truncate long descriptions — Gemini function calling silently fails beyond ~500 chars
      let description = t.function.description ?? '';
      if (description.length > 500) {
        const cut = description.indexOf('\n\n');
        description = cut > 0 && cut < 500 ? description.substring(0, cut) : description.substring(0, 500);
      }

      return { name: t.function.name, description, parameters: params };
    });

  return [{ functionDeclarations: decls }];
}

function removeUnsupportedSchemaFields(obj: any, depth = 0): void {
  if (!obj || typeof obj !== 'object') return;

  delete obj.additionalProperties;
  delete obj.default;

  // Gemini returns empty responses when nested array-item schemas have required fields
  if (depth > 0 && obj.type === 'object' && 'required' in obj) {
    delete obj.required;
  }

  for (const key of Object.keys(obj)) {
    if (typeof obj[key] === 'object') {
      removeUnsupportedSchemaFields(obj[key], depth + 1);
    }
  }

  if (Array.isArray(obj)) {
    obj.forEach((item) => removeUnsupportedSchemaFields(item, depth + 1));
  }
}
