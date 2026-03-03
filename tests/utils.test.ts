import {
  stripMarkdownCodeBlock,
  isRateLimitError,
  extractRetryAfterMs,
  estimateCost,
} from '../src/utils';

describe('stripMarkdownCodeBlock', () => {
  it('strips ```json ... ``` wrappers', () => {
    const input = '```json\n{"key": "value"}\n```';
    expect(stripMarkdownCodeBlock(input)).toBe('{"key": "value"}');
  });

  it('strips plain ``` wrappers', () => {
    const input = '```\n{"a": 1}\n```';
    expect(stripMarkdownCodeBlock(input)).toBe('{"a": 1}');
  });

  it('returns unchanged string when no backticks', () => {
    const input = '{"a": 1}';
    expect(stripMarkdownCodeBlock(input)).toBe('{"a": 1}');
  });

  it('handles multi-line JSON inside code blocks', () => {
    const input = '```json\n{\n  "a": 1,\n  "b": 2\n}\n```';
    const result = stripMarkdownCodeBlock(input);
    expect(JSON.parse(result)).toEqual({ a: 1, b: 2 });
  });
});

describe('isRateLimitError', () => {
  it('detects 429 in message', () => {
    expect(isRateLimitError(new Error('HTTP 429 Too Many Requests'))).toBe(true);
  });

  it('detects "resource exhausted"', () => {
    expect(isRateLimitError(new Error('RESOURCE_EXHAUSTED: quota exceeded'))).toBe(true);
  });

  it('detects "too many requests"', () => {
    expect(isRateLimitError(new Error('too many requests sent'))).toBe(true);
  });

  it('returns false for non-rate-limit errors', () => {
    expect(isRateLimitError(new Error('Network timeout'))).toBe(false);
    expect(isRateLimitError(new Error('Invalid API key'))).toBe(false);
  });

  it('returns false for non-Error values', () => {
    expect(isRateLimitError('string error')).toBe(false);
    expect(isRateLimitError(null)).toBe(false);
  });
});

describe('extractRetryAfterMs', () => {
  it('extracts seconds from "retry after N" pattern', () => {
    const err = new Error('Rate limit exceeded, retry after 30 seconds');
    expect(extractRetryAfterMs(err)).toBe(30_000);
  });

  it('returns undefined when no retry info present', () => {
    expect(extractRetryAfterMs(new Error('Some other error'))).toBeUndefined();
  });

  it('returns undefined for non-Error', () => {
    expect(extractRetryAfterMs(null)).toBeUndefined();
  });
});

describe('estimateCost', () => {
  it('calculates cost for gemini-2.0-flash', () => {
    // 1M input + 1M output at $0.10 + $0.40
    const cost = estimateCost(1_000_000, 1_000_000, 'gemini-2.0-flash');
    expect(cost).toBeCloseTo(0.50, 5);
  });

  it('calculates cost for gemini-2.5-pro', () => {
    const cost = estimateCost(1_000_000, 1_000_000, 'gemini-2.5-pro');
    expect(cost).toBeCloseTo(11.25, 5);
  });

  it('returns 0 for zero tokens', () => {
    expect(estimateCost(0, 0, 'gemini-2.0-flash')).toBe(0);
  });
});
