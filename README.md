# gemini-heal

**Resilience toolkit for the Google Gemini API.**
Rate limiting, `MALFORMED_FUNCTION_CALL` recovery, and circuit breaking — extracted from production.

[![npm version](https://img.shields.io/npm/v/gemini-heal.svg)](https://www.npmjs.com/package/gemini-heal)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Tests](https://img.shields.io/badge/tests-24%20passing-brightgreen.svg)](#running-tests)

---

We built this at [Emotix](https://emotix.co?utm_source=github&utm_medium=oss&utm_campaign=gemini-heal) while running Gemini inside a multi-agent research pipeline. Three problems kept surfacing:

**`MALFORMED_FUNCTION_CALL`** — Gemini's function calling silently breaks when tool arguments contain large strings. Google confirmed it as a P2 bug (still open). We spent days debugging it before finding the workaround.

**429s with no backoff** — The free tier is 10 RPM. Without a proper rate limiter the process would hang, queue up hundreds of requests, and eventually crash.

**JSON wrapped in markdown** — Even with `responseMimeType: 'application/json'`, Gemini returns ` ```json ``` ` blocks. Small thing, but it breaks `JSON.parse` in production.

This library is our fixes, packaged up.

---

## What's inside

| Module | What it does |
|---|---|
| `GeminiRateLimiter` | Adaptive token-bucket — halves RPM on 429, recovers slowly, circuit-breaks when queue is too deep |
| `GeminiClient` | Text completion with rate limiter integration, cost tracking, and markdown stripping |
| `ToolCaller` | Forced tool calling with `MALFORMED_FUNCTION_CALL` retry + structured output fallback |
| `stripMarkdownCodeBlock` | Strips ` ```json ``` ` wrappers from Gemini responses |
| `isRateLimitError` / `extractRetryAfterMs` | 429 detection helpers |

---

## Install

```bash
npm install gemini-heal @google/generative-ai
```

---

## Usage

### Rate limiter

```typescript
import { GeminiRateLimiter } from 'gemini-heal';

const limiter = new GeminiRateLimiter({ rpm: 60 });

// Call before every Gemini request
await limiter.acquire();

// Call when you get a 429
limiter.reportRateLimit();

// Check before calling Gemini — returns true when queue wait exceeds threshold
if (limiter.shouldSkip()) {
  // route to a fallback model
}

// Observability
console.log(limiter.getStats());
// { currentRpm: 60, queueDepth: 0, total429s: 0, estimatedWaitMs: 0, ... }

// Always call destroy() on shutdown to clean up timers
limiter.destroy();
```

The limiter automatically halves RPM on each 429 (floor: 2 RPM) and recovers by +2 RPM every 60 seconds of clean traffic. No configuration needed for the happy path — it adapts.

---

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
console.log(`Tokens: ${result.totalTokens} | Cost: $${result.cost.toFixed(6)} | ${result.latencyMs}ms`);
```

---

### Forced tool calling

This is the main reason we made this public.

`FunctionCallingMode.ANY` is supposed to guarantee a tool call. It doesn't. When arguments contain long strings (typically 1000+ characters), Gemini returns `finishReason: MALFORMED_FUNCTION_CALL` with no output. Two things fix it:

1. **Prompt instruction** — telling Gemini to properly JSON-escape string values cuts MALFORMED errors by ~90%. We verified this over 500+ production calls.
2. **Structured output fallback** — if function calling still fails after N retries, we switch to `responseMimeType: 'application/json'` + `responseSchema`. This bypasses the function-calling code path entirely. No MALFORMED possible.

```typescript
import { ToolCaller, GeminiRateLimiter, ToolDefinition } from 'gemini-heal';

const tools: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'analyze_market',
      description: 'Analyze a market segment and return structured insights.',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          opportunities: { type: 'array', items: { type: 'string' } },
          risks: { type: 'array', items: { type: 'string' } },
        },
        required: ['summary', 'opportunities', 'risks'],
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

console.log(result.strategy); // 'function_calling' or 'structured_output'
console.log(result.attempt);  // which attempt succeeded (1-indexed)
console.log(result.args);     // the tool arguments, ready to use
```

The `strategy` field is useful for monitoring — if you're seeing `structured_output` too often, something in your tool schema is triggering the Gemini bug.

---

### Tool definitions format

`ToolCaller` accepts tools in OpenAI's JSON Schema format. If you're already using OpenAI-format tools you can pass them directly — no conversion needed.

---

### Bring your own logger

Both `GeminiClient` and `ToolCaller` accept a `logger` option compatible with pino, winston, or any `{ info, warn, error, debug }` interface:

```typescript
import pino from 'pino';

const caller = new ToolCaller(apiKey, { logger: pino() });
```

By default, logs go to `console.log` / `console.warn` / `console.error`.

---

## API reference

### `GeminiRateLimiter`

```typescript
new GeminiRateLimiter(options?: RateLimiterOptions)
```

| Option | Type | Default | Description |
|---|---|---|---|
| `rpm` | `number` | `GEMINI_RPM_LIMIT` env, or `10` | Max requests per minute |
| `maxAcceptableWaitMs` | `number` | `15000` | `shouldSkip()` returns true above this |

| Method | Description |
|---|---|
| `acquire()` | Await a rate-limiter slot before calling Gemini |
| `reportRateLimit(retryAfterMs?)` | Tell the limiter a 429 was received |
| `shouldSkip()` | Circuit breaker — true when queue wait exceeds threshold |
| `getEstimatedWaitMs()` | Current queue depth in milliseconds |
| `getStats()` | Returns `RateLimiterStats` for observability |
| `destroy()` | Clean up internal timers |

---

### `GeminiClient`

```typescript
new GeminiClient(options: GeminiClientOptions)
```

| Option | Type | Default |
|---|---|---|
| `apiKey` | `string` | required |
| `model` | `string` | `gemini-2.0-flash` |
| `temperature` | `number` | `0.7` |
| `maxTokens` | `number` | `8192` |
| `jsonMode` | `boolean` | `false` |
| `rateLimiter` | `GeminiRateLimiter` | — |
| `logger` | `Logger` | `console` |

Returns `CompletionResult`: `{ content, model, inputTokens, outputTokens, totalTokens, latencyMs, cost }`.

---

### `ToolCaller`

```typescript
new ToolCaller(apiKey: string, options?: { logger?, rateLimiter? })

caller.run(systemPrompt, userMessage, tools, toolName, options?)
```

| Run option | Type | Default |
|---|---|---|
| `model` | `string` | `gemini-2.0-flash` |
| `temperature` | `number` | `0` |
| `maxAttempts` | `number` | `3` |
| `maxTokens` | `number` | `4096` |

Returns `ToolCallResult`: `{ toolName, args, attempt, strategy }`.

---

## Known Gemini issues this addresses

**`MALFORMED_FUNCTION_CALL`**
Tracked in [googleapis/python-genai#1120](https://github.com/googleapis/python-genai/issues/1120) and [googleapis/google-cloud-java#11782](https://github.com/googleapis/google-cloud-java/issues/11782). Gemini returns an error finish reason with no output when function call arguments contain large strings. The prompt-level fix in `ToolCaller` handles the common case; the structured output fallback handles everything else.

**JSON in markdown code blocks**
`responseMimeType: 'application/json'` does not always prevent Gemini from wrapping output in ` ```json ``` `. `stripMarkdownCodeBlock()` is a one-liner fix you can use anywhere.

**No built-in rate limit handling**
The `@google/generative-ai` SDK throws on 429 but provides no backoff. `GeminiRateLimiter` gives you a proactive token bucket so you never hit the limit in the first place, plus automatic recovery when you do.

---

## Running tests

```bash
npm install
npm test
```

24 unit tests covering rate limiter behavior, utility functions, and edge cases. Live API integration tests are not included — they'd consume your quota.

---

## Contributing

Issues and PRs are welcome. If you've hit a Gemini quirk that isn't handled here, open an issue with a minimal reproduction. We're particularly interested in:

- New `MALFORMED_FUNCTION_CALL` patterns
- Model-specific behavior differences (2.0 Flash vs 2.5 Pro vs 1.5 Pro)
- Retry strategies for streaming responses

---

## License

MIT — see [LICENSE](./LICENSE).

---

Built by the [Emotix](https://emotix.co?utm_source=github&utm_medium=oss&utm_campaign=gemini-heal) team.
