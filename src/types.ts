export interface RateLimiterOptions {
  /** Requests per minute. Defaults to GEMINI_RPM_LIMIT env var, or 10 (free tier). */
  rpm?: number;
  /** Skip Gemini if estimated queue wait exceeds this (ms). Default: 15000. */
  maxAcceptableWaitMs?: number;
}

export interface RateLimiterStats {
  currentRpm: number;
  configuredRpm: number;
  queueDepth: number;
  total429s: number;
  lastRateLimitAt: Date | null;
  estimatedWaitMs: number;
}

export interface GeminiClientOptions {
  apiKey: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** Return JSON — sets responseMimeType to application/json */
  jsonMode?: boolean;
  rateLimiter?: import('./rate-limiter').GeminiRateLimiter;
  logger?: Logger;
}

export interface CompletionResult {
  content: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  latencyMs: number;
  /** USD cost estimate based on published Gemini pricing */
  cost: number;
}

/** Tool definition in OpenAI JSON Schema format (same shape Gemini SDK also accepts after conversion) */
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolCallResult {
  toolName: string;
  args: Record<string, unknown>;
  /** Which attempt succeeded (1-indexed) */
  attempt: number;
  /** 'function_calling' if the normal path worked, 'structured_output' if we fell back */
  strategy: 'function_calling' | 'structured_output';
}

export interface ToolCallerOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  maxAttempts?: number;
  rateLimiter?: import('./rate-limiter').GeminiRateLimiter;
  logger?: Logger;
}

export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
}
