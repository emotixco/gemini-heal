import { GeminiRateLimiter } from '../src/rate-limiter';

describe('GeminiRateLimiter', () => {
  let limiter: GeminiRateLimiter;

  afterEach(() => {
    limiter?.destroy();
  });

  describe('acquire()', () => {
    it('resolves immediately when tokens are available', async () => {
      limiter = new GeminiRateLimiter({ rpm: 60 });
      const start = Date.now();
      await limiter.acquire();
      expect(Date.now() - start).toBeLessThan(50);
    });

    it('queues requests when tokens are exhausted', async () => {
      limiter = new GeminiRateLimiter({ rpm: 1 });
      // Drain the single token
      await limiter.acquire();

      const stats = limiter.getStats();
      expect(stats.queueDepth).toBe(0);

      // This acquire will queue
      let resolved = false;
      const pending = limiter.acquire().then(() => { resolved = true; });

      // Give it a tick — should still be waiting
      await new Promise((r) => setTimeout(r, 10));
      expect(resolved).toBe(false);

      limiter.destroy();
      // pending may never resolve — that's fine for this test
      void pending;
    });
  });

  describe('reportRateLimit()', () => {
    it('halves the current RPM on 429', () => {
      limiter = new GeminiRateLimiter({ rpm: 60 });
      limiter.reportRateLimit();

      const stats = limiter.getStats();
      expect(stats.currentRpm).toBe(30);
      expect(stats.total429s).toBe(1);
      expect(stats.lastRateLimitAt).not.toBeNull();
    });

    it('does not drop below MIN_RPM', () => {
      limiter = new GeminiRateLimiter({ rpm: 2 });
      limiter.reportRateLimit();
      limiter.reportRateLimit();
      limiter.reportRateLimit();

      expect(limiter.getStats().currentRpm).toBe(GeminiRateLimiter.MIN_RPM);
    });

    it('counts multiple 429s', () => {
      limiter = new GeminiRateLimiter({ rpm: 60 });
      limiter.reportRateLimit();
      limiter.reportRateLimit();

      expect(limiter.getStats().total429s).toBe(2);
      expect(limiter.getStats().currentRpm).toBe(15); // 60 / 2 / 2
    });
  });

  describe('shouldSkip()', () => {
    it('returns false when tokens are available', () => {
      limiter = new GeminiRateLimiter({ rpm: 60 });
      expect(limiter.shouldSkip()).toBe(false);
    });

    it('returns true when queue wait exceeds maxAcceptableWaitMs', () => {
      // Very low RPM means queue will be deep
      limiter = new GeminiRateLimiter({ rpm: 1, maxAcceptableWaitMs: 100 });

      // Drain the token
      limiter.acquire();

      // Queue enough requests that wait time exceeds 100ms
      for (let i = 0; i < 20; i++) {
        void limiter.acquire();
      }

      expect(limiter.shouldSkip()).toBe(true);
    });
  });

  describe('getStats()', () => {
    it('returns correct initial state', () => {
      limiter = new GeminiRateLimiter({ rpm: 30 });
      const stats = limiter.getStats();

      expect(stats.configuredRpm).toBe(30);
      expect(stats.currentRpm).toBe(30);
      expect(stats.queueDepth).toBe(0);
      expect(stats.total429s).toBe(0);
      expect(stats.lastRateLimitAt).toBeNull();
    });
  });

  describe('getEstimatedWaitMs()', () => {
    it('returns 0 when tokens are available', () => {
      limiter = new GeminiRateLimiter({ rpm: 60 });
      expect(limiter.getEstimatedWaitMs()).toBe(0);
    });
  });
});
