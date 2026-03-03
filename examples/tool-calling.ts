/**
 * Forced tool calling with MALFORMED_FUNCTION_CALL recovery.
 *
 * This is where gemini-heal shines — Gemini's function calling is
 * unreliable with large string arguments. ToolCaller handles retries
 * and falls back to structured output automatically.
 */
import { ToolCaller, GeminiRateLimiter, ToolDefinition } from '../src';

const tools: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'analyze_market',
      description: 'Analyze a market segment and return structured insights.',
      parameters: {
        type: 'object',
        properties: {
          market: { type: 'string', description: 'Market name or segment' },
          summary: { type: 'string', description: 'Brief market summary (2-3 sentences)' },
          opportunities: {
            type: 'array',
            items: { type: 'string' },
            description: 'List of 3-5 key opportunities',
          },
          risks: {
            type: 'array',
            items: { type: 'string' },
            description: 'List of 3-5 key risks',
          },
          size_estimate: { type: 'string', description: 'Estimated market size (e.g. "$4.2B TAM")' },
        },
        required: ['market', 'summary', 'opportunities', 'risks', 'size_estimate'],
      },
    },
  },
];

async function main() {
  const rateLimiter = new GeminiRateLimiter({ rpm: 60 });
  const caller = new ToolCaller(process.env.GOOGLE_AI_API_KEY!, { rateLimiter });

  const result = await caller.run(
    'You are a market research analyst.',
    'Analyze the AI coding assistant market in 2025.',
    tools,
    'analyze_market',
    { model: 'gemini-2.0-flash', maxAttempts: 3 },
  );

  console.log('Tool called:', result.toolName);
  console.log('Strategy used:', result.strategy); // 'function_calling' or 'structured_output'
  console.log('Succeeded on attempt:', result.attempt);
  console.log('Result:', JSON.stringify(result.args, null, 2));

  rateLimiter.destroy();
}

main().catch(console.error);
