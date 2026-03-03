/**
 * Gemini sometimes wraps JSON responses in ```json ... ``` blocks
 * even when you ask for plain JSON. Strip them before parsing.
 */
export function stripMarkdownCodeBlock(text: string): string {
  if (!text.includes('```')) return text;
  return text
    .replace(/```json\s*/g, '')
    .replace(/```\s*/g, '')
    .trim();
}

/**
 * Detect 429 / rate-limit errors from the Gemini SDK.
 * The SDK surfaces these as plain Error objects with message strings.
 */
export function isRateLimitError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return (
    msg.includes('429') ||
    msg.includes('too many requests') ||
    msg.includes('resource exhausted') ||
    msg.includes('resource_exhausted')
  );
}

/**
 * Pull a Retry-After duration out of a Gemini rate-limit error.
 * Returns undefined when no duration is present.
 */
export function extractRetryAfterMs(error: unknown): number | undefined {
  if (!(error instanceof Error)) return undefined;

  const match = error.message.match(/retry after (\d+)/i);
  if (match) return parseInt(match[1], 10) * 1_000;

  const details = (error as any).errorDetails;
  if (Array.isArray(details)) {
    for (const d of details) {
      if (d.retryDelay) {
        const secs = parseInt(d.retryDelay, 10);
        if (!isNaN(secs)) return secs * 1_000;
      }
    }
  }

  return undefined;
}

/**
 * Gemini pricing per 1M tokens (USD).
 * Source: https://ai.google.dev/gemini-api/docs/pricing
 * Last updated: 2025-Q2
 */
export function getModelPricing(model: string): { input: number; output: number } {
  if (model.includes('2.5-pro')) return { input: 1.25, output: 10.0 };
  if (model.includes('2.0-flash') || model.includes('flash')) return { input: 0.10, output: 0.40 };
  // Default / unknown
  return { input: 1.25, output: 10.0 };
}

export function estimateCost(inputTokens: number, outputTokens: number, model: string): number {
  const pricing = getModelPricing(model);
  return (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
}
