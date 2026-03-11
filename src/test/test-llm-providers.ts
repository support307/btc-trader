/**
 * Test script: Verify both LLM providers (Anthropic + Grok) work for classification.
 * Tests text-only, image+text, and failover scenarios.
 *
 * Usage: npx tsx src/test/test-llm-providers.ts
 */

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { config } from '../config';

const SYSTEM_PROMPT = `You classify messages from a Discord options trading guru into exactly one of 7 types. Respond ONLY with valid JSON.

Message Types:
1. GAMEPLAN — morning plan with tickers
2. ENTRY — specific trade signal (ticker + strike + price)
3. SCALE_IN — guru adding to existing position
4. UPDATE — market commentary, no action
5. PARTIAL_EXIT — sell half
6. FULL_EXIT — sell all
7. IRRELEVANT — off-topic

Respond ONLY with: {"type":"...", "confidence":0.95, "reasoning":"..."}`;

const TEST_MESSAGES = [
  { label: 'GAMEPLAN', text: 'Todays gameplan $SPY @everyone As much as I want to buy puts, we dropped hard. I have to do calls' },
  { label: 'ENTRY', text: '$IWM Call at $262 at 0.19 @everyone' },
  { label: 'PARTIAL_EXIT', text: "There's the 120% gain. You guys know what to do @everyone" },
  { label: 'FULL_EXIT', text: 'Sell all. Done for the day @everyone' },
  { label: 'UPDATE', text: 'Amazing pump so far @everyone' },
  { label: 'SCALE_IN', text: 'Adding more here @everyone' },
];

const SAMPLE_IMAGE_URL = 'https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?w=400';

function ok(msg: string) { console.log(`  \x1b[32m✓ PASS\x1b[0m  ${msg}`); }
function fail(msg: string) { console.log(`  \x1b[31m✗ FAIL\x1b[0m  ${msg}`); }

async function testAnthropic(): Promise<boolean> {
  console.log('\n══ Test 1: Anthropic (Claude) — Text Classification ══\n');

  const apiKey = config.llm.anthropicApiKey;
  if (!apiKey) { fail('ANTHROPIC_API_KEY not set'); return false; }

  const client = new Anthropic({ apiKey });
  let passed = 0;

  for (const tc of TEST_MESSAGES) {
    try {
      const response = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 200,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: tc.text }],
      });

      const rawText = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map(b => b.text).join('');
      const cleaned = rawText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const parsed = JSON.parse(cleaned);

      if (parsed.type === tc.label) {
        ok(`${tc.label}: "${tc.text.substring(0, 50)}..." → ${parsed.type} (${(parsed.confidence * 100).toFixed(0)}%)`);
        passed++;
      } else {
        fail(`Expected ${tc.label}, got ${parsed.type}: "${tc.text.substring(0, 50)}..."`);
      }
    } catch (err: any) {
      fail(`${tc.label}: ${err.message}`);
    }
  }

  console.log(`\n  Anthropic text: ${passed}/${TEST_MESSAGES.length} passed`);
  return passed === TEST_MESSAGES.length;
}

async function testAnthropicImage(): Promise<boolean> {
  console.log('\n══ Test 2: Anthropic (Claude) — Image Handling ══\n');

  const apiKey = config.llm.anthropicApiKey;
  if (!apiKey) { fail('ANTHROPIC_API_KEY not set'); return false; }

  const client = new Anthropic({ apiKey });

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 200,
      system: SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'url', url: SAMPLE_IMAGE_URL } },
          { type: 'text', text: 'What a huge day for us @everyone' },
        ],
      }],
    });

    const rawText = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text).join('');
    const cleaned = rawText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(cleaned);

    ok(`Image + text → ${parsed.type} (${(parsed.confidence * 100).toFixed(0)}%): ${parsed.reasoning}`);
    return true;
  } catch (err: any) {
    fail(`Anthropic image test failed: ${err.message}`);
    return false;
  }
}

async function testGrok(): Promise<boolean> {
  console.log('\n══ Test 3: Grok (xAI) — Text Classification ══\n');

  const apiKey = config.llm.grokApiKey;
  if (!apiKey) { fail('GROK_API_KEY not set'); return false; }

  const client = new OpenAI({ apiKey, baseURL: 'https://api.x.ai/v1' });
  let passed = 0;

  for (const tc of TEST_MESSAGES) {
    try {
      const response = await client.chat.completions.create({
        model: 'grok-3-mini-fast',
        max_tokens: 200,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: tc.text },
        ],
      }, { timeout: 10000 });

      const text = response.choices[0]?.message?.content || '';
      const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const parsed = JSON.parse(cleaned);

      if (parsed.type === tc.label) {
        ok(`${tc.label}: "${tc.text.substring(0, 50)}..." → ${parsed.type} (${(parsed.confidence * 100).toFixed(0)}%)`);
        passed++;
      } else {
        fail(`Expected ${tc.label}, got ${parsed.type}: "${tc.text.substring(0, 50)}..."`);
      }
    } catch (err: any) {
      fail(`${tc.label}: ${err.message}`);
    }
  }

  console.log(`\n  Grok text: ${passed}/${TEST_MESSAGES.length} passed`);
  return passed === TEST_MESSAGES.length;
}

async function testGrokImage(): Promise<boolean> {
  console.log('\n══ Test 4: Grok (xAI) — Image Handling ══\n');

  const apiKey = config.llm.grokApiKey;
  if (!apiKey) { fail('GROK_API_KEY not set'); return false; }

  const client = new OpenAI({ apiKey, baseURL: 'https://api.x.ai/v1' });

  try {
    const response = await client.chat.completions.create({
      model: 'grok-4-1-fast-non-reasoning',
      max_tokens: 200,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: SAMPLE_IMAGE_URL } },
            { type: 'text', text: 'What a huge day for us @everyone' },
          ],
        },
      ],
    }, { timeout: 15000 });

    const text = response.choices[0]?.message?.content || '';
    const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(cleaned);

    ok(`Image + text → ${parsed.type} (${(parsed.confidence * 100).toFixed(0)}%): ${parsed.reasoning}`);
    return true;
  } catch (err: any) {
    fail(`Grok image test failed: ${err.message}`);
    return false;
  }
}

async function testFailover(): Promise<boolean> {
  console.log('\n══ Test 5: Failover (Anthropic → Grok) ══\n');

  const { classifyWithLLM } = await import('../parser/llm-classifier');

  try {
    const result = await classifyWithLLM(
      'Sell all. Done for the day @everyone',
      [],
      [],
    );

    if (result) {
      ok(`Failover chain returned: ${result.type} via ${result.provider} (${(result.confidence * 100).toFixed(0)}%)`);
      return true;
    } else {
      fail('classifyWithLLM returned null — both providers failed');
      return false;
    }
  } catch (err: any) {
    fail(`Failover test error: ${err.message}`);
    return false;
  }
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║     LLM Provider Test — Anthropic + Grok Failover      ║');
  console.log('╚══════════════════════════════════════════════════════════╝');

  const results: { name: string; passed: boolean }[] = [];

  results.push({ name: 'Anthropic Text', passed: await testAnthropic() });
  results.push({ name: 'Anthropic Image', passed: await testAnthropicImage() });
  results.push({ name: 'Grok Text', passed: await testGrok() });
  results.push({ name: 'Grok Image', passed: await testGrokImage() });
  results.push({ name: 'Failover Chain', passed: await testFailover() });

  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  RESULTS\n');
  for (const r of results) {
    if (r.passed) ok(r.name);
    else fail(r.name);
  }
  const total = results.filter(r => r.passed).length;
  console.log(`\n  ${total}/${results.length} tests passed.`);
  console.log('══════════════════════════════════════════════════════════\n');

  process.exit(total === results.length ? 0 : 1);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
