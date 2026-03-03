import { RateLimiterOptions, RateLimiterStats } from './types';

/**
 * Adaptive token-bucket rate limiter for the Gemini API.
 *
 * Keeps all Gemini calls below your configured RPM, dynamically backs
 * off when 429s arrive, and slowly recovers once errors stop.
 *
 * Usage:
 *   const limiter = new GeminiRateLimiter({ rpm: 60 });
 *   await limiter.acquire(); // call before every Gemini request
 *   // ... your generateContent call ...
 *   // On 429: limiter.reportRateLimit();
 */
export class GeminiRateLimiter {
  private configuredRpm: number;
  private currentRpm: number;
  private tokens: number;
  private lastRefillTime: number;
  private queue: Array<{ resolve: () => void }> = [];
  private total429s = 0;
  private lastRateLimitAt: Date | null = null;
  private refillTimer: ReturnType<typeof setInterval>;
  private recoveryTimer: ReturnType<typeof setInterval>;
  private pauseUntil = 0;

  static readonly MIN_RPM = 2;
  static readonly RECOVERY_INTERVAL_MS = 60_000;
  static readonly RECOVERY_INCREMENT = 2;

  readonly maxAcceptableWaitMs: number;

  constructor(options: RateLimiterOptions = {}) {
    this.configuredRpm = options.rpm ?? parseInt(process.env.GEMINI_RPM_LIMIT ?? '10', 10);
    this.maxAcceptableWaitMs = options.maxAcceptableWaitMs ?? 15_000;
    this.currentRpm = this.configuredRpm;
    this.tokens = this.currentRpm;
    this.lastRefillTime = Date.now();

    this.refillTimer = setInterval(() => this.refill(), 1_000);
    this.recoveryTimer = setInterval(() => this.tryRecover(), GeminiRateLimiter.RECOVERY_INTERVAL_MS);
  }

  /**
   * Acquire a request slot. Resolves immediately when a token is available,
   * otherwise queues and resolves as soon as one opens up.
   */
  async acquire(): Promise<void> {
    this.refill();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }

    return new Promise<void>((resolve) => {
      this.queue.push({ resolve });
    });
  }

  /**
   * Call this whenever Gemini returns a 429.
   * Halves the current RPM (floor: MIN_RPM) and optionally pauses
   * token refills for the Retry-After duration.
   */
  reportRateLimit(retryAfterMs?: number): void {
    this.total429s++;
    this.lastRateLimitAt = new Date();
    this.currentRpm = Math.max(GeminiRateLimiter.MIN_RPM, Math.floor(this.currentRpm / 2));
    this.tokens = 0;

    if (retryAfterMs && retryAfterMs > 0) {
      this.pauseUntil = Date.now() + retryAfterMs;
    }
  }

  /**
   * Estimated wait time in ms for the next queued request.
   * Returns 0 when a token is immediately available.
   */
  getEstimatedWaitMs(): number {
    const now = Date.now();
    const pauseRemaining = this.pauseUntil > now ? this.pauseUntil - now : 0;

    if (this.tokens >= 1 && pauseRemaining === 0) return 0;

    const requestsAhead = this.queue.length + 1;
    const rps = this.currentRpm / 60;
    const queueWaitMs = rps > 0 ? (requestsAhead / rps) * 1_000 : Infinity;

    return Math.max(pauseRemaining, queueWaitMs);
  }

  /**
   * Circuit-breaker check: returns true when the queue is so deep that
   * you're better off skipping Gemini and trying a fallback model.
   */
  shouldSkip(): boolean {
    return this.getEstimatedWaitMs() > this.maxAcceptableWaitMs;
  }

  getStats(): RateLimiterStats {
    return {
      currentRpm: this.currentRpm,
      configuredRpm: this.configuredRpm,
      queueDepth: this.queue.length,
      total429s: this.total429s,
      lastRateLimitAt: this.lastRateLimitAt,
      estimatedWaitMs: this.getEstimatedWaitMs(),
    };
  }

  /** Clean up timers — call on graceful shutdown or in tests. */
  destroy(): void {
    clearInterval(this.refillTimer);
    clearInterval(this.recoveryTimer);
  }

  private refill(): void {
    const now = Date.now();
    if (now < this.pauseUntil) return;

    const elapsed = now - this.lastRefillTime;
    const newTokens = (elapsed * this.currentRpm) / 60_000;

    if (newTokens >= 0.01) {
      this.tokens = Math.min(this.tokens + newTokens, this.currentRpm);
      this.lastRefillTime = now;

      while (this.queue.length > 0 && this.tokens >= 1) {
        this.tokens -= 1;
        this.queue.shift()!.resolve();
      }
    }
  }

  private tryRecover(): void {
    if (!this.lastRateLimitAt) return;
    if (this.currentRpm >= this.configuredRpm) return;

    const msSince = Date.now() - this.lastRateLimitAt.getTime();
    if (msSince >= GeminiRateLimiter.RECOVERY_INTERVAL_MS) {
      this.currentRpm = Math.min(
        this.configuredRpm,
        this.currentRpm + GeminiRateLimiter.RECOVERY_INCREMENT,
      );
    }
  }
}
