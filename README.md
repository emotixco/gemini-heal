# gemini-heal

Production-grade resilience toolkit for the Google Gemini API.

We built this at [Emotix](https://emotix.app?utm_source=github&utm_medium=oss&utm_campaign=gemini-heal) while running Gemini in a multi-agent research pipeline. After a few weeks in production we kept running into the same failures:

- `MALFORMED_FUNCTION_CALL` on tool calls with large string arguments (Google acknowledged this as a P2 bug — still unfixed as of 2025-Q2)
- 429s on the free tier hammering the queue and hanging the process
- Gemini wrapping JSON responses in ` ```json ``` ` blocks even when we asked for plain JSON
- No way to know if the Gemini queue was backed up before making a call

So we extracted our battle-tested fixes into this library.

## What's inside

| Module | What it does |
|---|---|
| `GeminiRateLimiter` | Token-bucket rate limiter with adaptive backoff and circuit breaker |
| `GeminiClient` | Text completion client with rate-limiter integration and cost tracking |
| `ToolCaller` | Forced tool calling with `MALFORMED_FUNCTION_CALL` retry + structured output fallback |
| `stripMarkdownCodeBlock` | Strips ` ```json ``` ` wrappers Gemini adds to JSON responses |
| `isRateLimitError` / `extractRetryAfterMs` | 429 detection helpers |

## Install

```bash
npm install gemini-heal @google/generative-ai
```

## Usage

### Rate limiter

```typescript
import { GeminiRateLimiter } from 'gemini-heal';

const limiter = new GeminiRateLimiter({ rpm: 60 });

// Before every Gemini API call:
await limiter.acquire();

// When you get a 429:
limiter.reportRateLimit();

// Circuit breaker — skip Gemini if queue is too deep:
if (limiter.shouldSkip()) {
  // fall back to another model
}

// Stats for observability:
console.log(limiter.getStats());
// { currentRpm: 60, queueDepth: 0, total429s: 0, estimatedWaitMs: 0, ... }

// Clean up timers on shutdown:
limiter.destroy();
```

The limiter automatically halves the RPM when it receives a `reportRateLimit()` call (minimum 2 RPM), and slowly recovers back to the configured RPM after 60 seconds of clean traffic.

### Text completion

```typescript
import { GeminiClient, GeminiRateLimiter } from 'gemini-heal';

const limiter = new GeminiRateLimiter({ rpm: 60 });
const client = new GeminiClient({
  apiKey: process.env.GOOGLE_AI_API_KEY!,
  model: 'gemini-2.0-flash',
  rateLimiter: limiter,
});

const result = await client.complete(
  'You are a helpful assistant.',
  'Summarize the current state of LLM tool calling.',
);

console.log(result.content);
console.log(`Cost: $${result.cost.toFixed(6)} | Tokens: ${result.totalTokens}`);
```

### Forced tool calling (with MALFORMED_FUNCTION_CALL fix)

This is the main reason we made this library public.

Gemini's `FunctionCallingMode.ANY` is supposed to guarantee a tool call, but it doesn't. When tool arguments contain long strings (usually 1000+ chars), Gemini returns `finishReason: MALFORMED_FUNCTION_CALL` and gives you nothing. The fix turns out to be two things:

1. Add an explicit JSON-escaping instruction to the prompt. This alone reduces MALFORMED errors by ~90%.
2. If function calling still fails after N retries, fall back to `responseMimeType: 'application/json'` + `responseSchema`. This sidesteps the function-calling code path entirely.

```typescript
import { ToolCaller, GeminiRateLimiter, ToolDefinition } from 'gemini-heal';

const tools: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'analyze_market',
      description: 'Analyze a market and return structured insights.',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          opportunities: { type: 'array', items: { type: 'string' } },
        },
        required: ['summary', 'opportunities'],
      },
    },
  },
];

const limiter = new GeminiRateLimiter({ rpm: 60 });
const caller = new ToolCaller(process.env.GOOGLE_AI_API_KEY!, { rateLimiter: limiter });

const result = await caller.run(
  'You are a market research analyst.',
  'Analyze the AI coding assistant market in 2025.',
  tools,
  'analyze_market',
  { maxAttempts: 3 },
);

console.log(result.strategy);  // 'function_calling' or 'structured_output'
console.log(result.attempt);   // which attempt succeeded
console.log(result.args);      // the tool arguments
```

The `strategy` field tells you whether the normal function-calling path worked or if it fell back to structured output — useful for monitoring.

### Tool definitions format

`ToolCaller` accepts tool definitions in OpenAI's JSON Schema format (same as `openai.chat.completions.create({ tools: [...] })`). If you're already using OpenAI-format tools you can pass them directly.

### Bring your own logger

Both `GeminiClient` and `ToolCaller` accept a `logger` option:

```typescript
import pino from 'pino';

const logger = pino();
const caller = new ToolCaller(apiKey, { logger });
```

Logger interface: `{ info, warn, error, debug }` — compatible with pino, winston, or console.

## API reference

### `GeminiRateLimiter`

| Option | Type | Default | Description |
|---|---|---|---|
| `rpm` | `number` | `GEMINI_RPM_LIMIT` env or `10` | Max requests per minute |
| `maxAcceptableWaitMs` | `number` | `15000` | `shouldSkip()` threshold |

Methods: `acquire()`, `reportRateLimit(retryAfterMs?)`, `shouldSkip()`, `getEstimatedWaitMs()`, `getStats()`, `destroy()`

### `ToolCaller`

| Option | Type | Default | Description |
|---|---|---|---|
| `model` | `string` | `gemini-2.0-flash` | Gemini model to use |
| `temperature` | `number` | `0` | 0 is recommended for function calling |
| `maxAttempts` | `number` | `3` | Retry attempts before structured output fallback |
| `rateLimiter` | `GeminiRateLimiter` | — | Optional shared rate limiter |

## Known Gemini quirks this addresses

**MALFORMED_FUNCTION_CALL** ([python-genai#1120](https://github.com/googleapis/python-genai/issues/1120), [google-cloud-java#11782](https://github.com/googleapis/google-cloud-java/issues/11782))
Gemini returns `finishReason: MALFORMED_FUNCTION_CALL` when tool argument strings are large. Google categorized this P2 in their internal tracker. The prompt-level fix here reduces it significantly; structured output eliminates it entirely.

**JSON in markdown code blocks**
Even with `responseMimeType: 'application/json'`, Gemini sometimes wraps the response in ` ```json ``` `. `stripMarkdownCodeBlock()` handles this.

**Free tier 429s**
The free tier is 10 RPM. The `GeminiRateLimiter` keeps you under that limit, backs off on 429s, and slowly recovers — so you don't have to manage this yourself.

## Running tests

```bash
npm install
npm test
```

Tests cover rate limiter behavior, utility functions, and edge cases. Integration tests against the live API are not included (they'd burn your quota).

## Contributing

Issues and PRs are welcome. If you've found another Gemini quirk worth handling, open an issue with a reproduction case.

## License

MIT — see [LICENSE](./LICENSE).

---

Built by the [Emotix](https://emotix.app?utm_source=github&utm_medium=oss&utm_campaign=gemini-heal) team.
