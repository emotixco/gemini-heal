import { GoogleGenerativeAI } from '@google/generative-ai';
import {
  GeminiClientOptions,
  CompletionResult,
  Logger,
} from './types';
import { GeminiRateLimiter } from './rate-limiter';
import { stripMarkdownCodeBlock, isRateLimitError, extractRetryAfterMs, estimateCost } from './utils';

const defaultLogger: Logger = {
  info: (msg, meta) => console.log(`[gemini-heal] ${msg}`, meta ?? ''),
  warn: (msg, meta) => console.warn(`[gemini-heal] ${msg}`, meta ?? ''),
  error: (msg, meta) => console.error(`[gemini-heal] ${msg}`, meta ?? ''),
  debug: () => {},
};

/**
 * Resilient Gemini text completion client.
 *
 * Wraps @google/generative-ai with:
 * - Rate limiter integration (token bucket + circuit breaker)
 * - Automatic markdown code-block stripping from JSON responses
 * - 429 / overload detection with rate-limiter feedback
 * - Cost estimation per call
 *
 * Example:
 *   const client = new GeminiClient({ apiKey: process.env.GOOGLE_AI_API_KEY! });
 *   const result = await client.complete('You are helpful.', 'Hello!');
 */
export class GeminiClient {
  private genAI: GoogleGenerativeAI;
  private options: Required<Omit<GeminiClientOptions, 'rateLimiter' | 'logger'>> & {
    rateLimiter: GeminiRateLimiter | null;
    logger: Logger;
  };

  constructor(options: GeminiClientOptions) {
    this.genAI = new GoogleGenerativeAI(options.apiKey);
    this.options = {
      apiKey: options.apiKey,
      model: options.model ?? 'gemini-2.0-flash',
      temperature: options.temperature ?? 0.7,
      maxTokens: options.maxTokens ?? 8_192,
      jsonMode: options.jsonMode ?? false,
      rateLimiter: options.rateLimiter ?? null,
      logger: options.logger ?? defaultLogger,
    };
  }

  async complete(systemPrompt: string, userPrompt: string): Promise<CompletionResult> {
    const { model, temperature, maxTokens, jsonMode, rateLimiter, logger } = this.options;
    const startTime = Date.now();

    // Circuit breaker — skip early if queue too deep
    if (rateLimiter?.shouldSkip()) {
      throw Object.assign(
        new Error('GEMINI_RATE_LIMITED: queue wait exceeds threshold'),
        { isGeminiRateLimit: true },
      );
    }

    if (rateLimiter) await rateLimiter.acquire();

    const geminiModel = this.genAI.getGenerativeModel({ model });

    const generationConfig: Record<string, unknown> = {
      temperature,
      maxOutputTokens: maxTokens,
      topP: 0.95,
      ...(jsonMode ? { responseMimeType: 'application/json' } : {}),
    };

    try {
      const result = await geminiModel.generateContent({
        contents: [{ role: 'user', parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }] }],
        generationConfig,
      });

      const response = result.response;
      let text = response.text();

      if (jsonMode && text.includes('```')) {
        text = stripMarkdownCodeBlock(text);
        logger.debug('Stripped markdown code blocks from JSON response');
      }

      const usage = (response as any).usageMetadata ?? {};
      const inputTokens: number = usage.promptTokenCount ?? 0;
      const outputTokens: number = usage.candidatesTokenCount ?? 0;

      return {
        content: text,
        model,
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        latencyMs: Date.now() - startTime,
        cost: estimateCost(inputTokens, outputTokens, model),
      };
    } catch (error) {
      if (isRateLimitError(error)) {
        const retryAfterMs = extractRetryAfterMs(error);
        rateLimiter?.reportRateLimit(retryAfterMs);
        logger.warn('Gemini 429 — reported to rate limiter', { retryAfterMs });
        throw Object.assign(
          new Error(`GEMINI_RATE_LIMITED: ${(error as Error).message}`),
          { isGeminiRateLimit: true },
        );
      }
      throw error;
    }
  }
}
