/**
 * Daily Preflight Test Suite
 *
 * Runs 8 sequential checks to verify all system components are operational
 * before market open. Designed to be run by OpenClaw or manually.
 *
 * Usage: npm run test:preflight
 *    or: npx tsx src/test/preflight.ts
 */

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { config } from '../config';
import { AlpacaClient } from '../alpaca/client';
import { MessageClassifier } from '../parser/message-classifier';
import * as fs from 'fs';
import * as path from 'path';

const DISCORD_API = 'https://discord.com/api/v10';
const STATE_PATH = path.join(__dirname, '..', '..', 'state', 'trading-state.json');

const TEST_ENTRY_MSG = 'High IV @everyone\n\n3/10 $IWM Call at $265 at 0.15';
const LLM_SYSTEM_PROMPT = `You classify messages from a Discord options trading guru. Respond ONLY with valid JSON: {"type":"ENTRY","confidence":0.95,"reasoning":"..."}. Types: GAMEPLAN, ENTRY, SCALE_IN, UPDATE, PARTIAL_EXIT, FULL_EXIT, IRRELEVANT.`;

interface CheckResult {
  pass: boolean;
  message: string;
}

function print(result: CheckResult): void {
  const tag = result.pass ? '\x1b[32m[PASS]\x1b[0m' : '\x1b[31m[FAIL]\x1b[0m';
  console.log(`${tag} ${result.message}`);
}

// ── Check 1: Environment Variables ──

function checkEnvVars(): CheckResult {
  const keys = [
    'DISCORD_USER_TOKEN',
    'DISCORD_CHANNEL_ID',
    'ALPACA_API_KEY',
    'ALPACA_API_SECRET',
    'DISCORD_WEBHOOK_URL',
    'ANTHROPIC_API_KEY',
    'GROK_API_KEY',
  ];

  const missing = keys.filter(k => !process.env[k]);
  if (missing.length === 0) {
    return { pass: true, message: `Env vars: ${keys.length}/${keys.length} keys set` };
  }
  return { pass: false, message: `Env vars: ${keys.length - missing.length}/${keys.length} set — missing: ${missing.join(', ')}` };
}

// ── Check 2: Alpaca API ──

async function checkAlpaca(): Promise<CheckResult> {
  try {
    const alpaca = new AlpacaClient();
    const account = await alpaca.getAccount();
    const equity = parseFloat(account.portfolio_value).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
    return { pass: true, message: `Alpaca API: ${equity} equity, ${account.status}` };
  } catch (err: any) {
    return { pass: false, message: `Alpaca API: ${err.message}` };
  }
}

// ── Check 3: Discord Channel Read ──

async function checkDiscordRead(): Promise<CheckResult> {
  try {
    const { channelId, userToken } = config.discord;
    const url = `${DISCORD_API}/channels/${channelId}/messages?limit=1`;
    const res = await fetch(url, { headers: { Authorization: userToken } });

    if (!res.ok) {
      const body = await res.text();
      return { pass: false, message: `Discord read: HTTP ${res.status} — ${body.substring(0, 100)}` };
    }

    const messages = await res.json() as any[];
    if (!Array.isArray(messages)) {
      return { pass: false, message: 'Discord read: unexpected response format' };
    }

    return { pass: true, message: `Discord read: channel accessible, ${messages.length} message fetched` };
  } catch (err: any) {
    return { pass: false, message: `Discord read: ${err.message}` };
  }
}

// ── Check 4: Discord Webhook ──

async function checkWebhook(): Promise<CheckResult> {
  const webhookUrl = config.notifications.discordWebhookUrl;
  if (!webhookUrl) {
    return { pass: false, message: 'Discord webhook: DISCORD_WEBHOOK_URL not set' };
  }

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{
          description: 'Preflight check — system verification. All systems nominal.',
          color: 0x00ff00,
          footer: { text: 'Discord Trader Preflight' },
          timestamp: new Date().toISOString(),
        }],
      }),
    });

    if (res.status === 429) {
      return { pass: true, message: 'Discord webhook: rate limited but endpoint reachable' };
    }

    if (!res.ok) {
      return { pass: false, message: `Discord webhook: HTTP ${res.status}` };
    }

    return { pass: true, message: 'Discord webhook: notification sent' };
  } catch (err: any) {
    return { pass: false, message: `Discord webhook: ${err.message}` };
  }
}

// ── Check 5: Anthropic LLM ──

async function checkAnthropic(): Promise<CheckResult> {
  const apiKey = config.llm.anthropicApiKey;
  if (!apiKey) {
    return { pass: false, message: 'Anthropic LLM: ANTHROPIC_API_KEY not set' };
  }

  try {
    const client = new Anthropic({ apiKey });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 200,
      system: LLM_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `Classify this guru message:\n\n"${TEST_ENTRY_MSG}"` }],
    }, { signal: controller.signal as any });

    clearTimeout(timeout);

    let text = response.content[0].type === 'text' ? response.content[0].text : '';
    text = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(text);

    if (parsed.type && parsed.confidence) {
      return { pass: true, message: `Anthropic LLM: ${parsed.type} classified (${Math.round(parsed.confidence * 100)}% confidence)` };
    }

    return { pass: false, message: `Anthropic LLM: unexpected response format` };
  } catch (err: any) {
    return { pass: false, message: `Anthropic LLM: ${err.message?.substring(0, 80)}` };
  }
}

// ── Check 6: Grok LLM ──

async function checkGrok(): Promise<CheckResult> {
  const apiKey = config.llm.grokApiKey;
  if (!apiKey) {
    return { pass: false, message: 'Grok LLM: GROK_API_KEY not set' };
  }

  try {
    const client = new OpenAI({ apiKey, baseURL: 'https://api.x.ai/v1' });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);

    const response = await client.chat.completions.create({
      model: 'grok-3-mini-fast',
      messages: [
        { role: 'system', content: LLM_SYSTEM_PROMPT },
        { role: 'user', content: `Classify this guru message:\n\n"${TEST_ENTRY_MSG}"` },
      ],
      temperature: 0.1,
      max_tokens: 200,
    }, { signal: controller.signal });

    clearTimeout(timeout);

    let text = response.choices[0]?.message?.content || '';
    text = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(text);

    if (parsed.type && parsed.confidence) {
      return { pass: true, message: `Grok LLM: ${parsed.type} classified (${Math.round(parsed.confidence * 100)}% confidence)` };
    }

    return { pass: false, message: 'Grok LLM: unexpected response format' };
  } catch (err: any) {
    return { pass: false, message: `Grok LLM: ${err.message?.substring(0, 80)}` };
  }
}

// ── Check 7: Full Classifier Pipeline ──

async function checkClassifierPipeline(): Promise<CheckResult> {
  try {
    const classified = await MessageClassifier.classify(TEST_ENTRY_MSG, `preflight-${Date.now()}`);

    if (classified.type !== 'ENTRY') {
      return { pass: false, message: `Classifier pipeline: expected ENTRY, got ${classified.type} (via ${classified.classifiedBy})` };
    }

    if (!classified.signal) {
      return { pass: false, message: `Classifier pipeline: ENTRY but no signal parsed (via ${classified.classifiedBy})` };
    }

    const provider = classified.classifiedBy || 'unknown';
    const isLlm = provider === 'anthropic' || provider === 'grok';

    return {
      pass: true,
      message: `Classifier pipeline: ENTRY via ${provider}${isLlm ? '' : ' (WARNING: regex fallback)'} — ${classified.signal.ticker} $${classified.signal.strikePrice} ${classified.signal.direction} @ $${classified.signal.entryPrice}`,
    };
  } catch (err: any) {
    return { pass: false, message: `Classifier pipeline: ${err.message}` };
  }
}

// ── Check 8: Trading State ──

function checkTradingState(): CheckResult {
  try {
    if (!fs.existsSync(STATE_PATH)) {
      return { pass: true, message: 'Trading state: no state file (will be created on first run)' };
    }

    const raw = fs.readFileSync(STATE_PATH, 'utf8');
    const state = JSON.parse(raw);
    const posCount = Object.keys(state.positions || {}).length;
    const closedCount = (state.closedToday || []).length;
    const bought = state.boughtToday === true;

    const issues: string[] = [];
    if (posCount > 0) issues.push(`${posCount} open position(s)`);
    if (closedCount > 0) issues.push(`${closedCount} closed trade(s)`);
    if (bought) issues.push('boughtToday=true');

    if (issues.length === 0) {
      return { pass: true, message: 'Trading state: clean (no positions, boughtToday=false)' };
    }

    return { pass: true, message: `Trading state: ${issues.join(', ')} — may need reset if starting fresh` };
  } catch (err: any) {
    return { pass: false, message: `Trading state: ${err.message}` };
  }
}

// ── Main ──

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║           DAILY PREFLIGHT TEST SUITE                    ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  const results: CheckResult[] = [];

  const checks: Array<{ name: string; fn: () => CheckResult | Promise<CheckResult> }> = [
    { name: 'Env vars', fn: checkEnvVars },
    { name: 'Alpaca API', fn: checkAlpaca },
    { name: 'Discord read', fn: checkDiscordRead },
    { name: 'Discord webhook', fn: checkWebhook },
    { name: 'Anthropic LLM', fn: checkAnthropic },
    { name: 'Grok LLM', fn: checkGrok },
    { name: 'Classifier pipeline', fn: checkClassifierPipeline },
    { name: 'Trading state', fn: checkTradingState },
  ];

  for (const check of checks) {
    try {
      const result = await check.fn();
      results.push(result);
      print(result);
    } catch (err: any) {
      const result = { pass: false, message: `${check.name}: unexpected error — ${err.message}` };
      results.push(result);
      print(result);
    }
  }

  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;
  const total = results.length;

  console.log(`\n${'═'.repeat(58)}`);

  if (failed === 0) {
    console.log(`\x1b[32mPREFLIGHT: ${passed}/${total} PASSED -- system ready for trading\x1b[0m`);
  } else {
    console.log(`\x1b[31mPREFLIGHT: ${passed}/${total} PASSED, ${failed} FAILED -- DO NOT TRADE until fixed\x1b[0m`);
  }

  console.log('');
  process.exit(failed > 0 ? 1 : 0);
}

main();
