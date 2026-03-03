/**
 * Basic usage — text completion with rate limiting
 */
import { GeminiClient, GeminiRateLimiter } from '../src';

async function main() {
  const rateLimiter = new GeminiRateLimiter({ rpm: 60 });

  const client = new GeminiClient({
    apiKey: process.env.GOOGLE_AI_API_KEY!,
    model: 'gemini-2.0-flash',
    rateLimiter,
  });

  const result = await client.complete(
    'You are a helpful assistant.',
    'What are the top 3 challenges when building with the Gemini API?',
  );

  console.log(result.content);
  console.log(`Tokens: ${result.totalTokens}, Cost: $${result.cost.toFixed(6)}, Latency: ${result.latencyMs}ms`);

  // Check rate limiter stats
  console.log('Rate limiter stats:', rateLimiter.getStats());

  rateLimiter.destroy();
}

main().catch(console.error);
