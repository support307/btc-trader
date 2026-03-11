import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { config } from '../config';
import { logger } from '../utils/logger';
import { TradeSignal } from './types';

export interface ContextMessage {
  text: string;
  timestamp: string;
  classification: string;
}

export interface LLMClassification {
  type: 'GAMEPLAN' | 'ENTRY' | 'SCALE_IN' | 'UPDATE' | 'PARTIAL_EXIT' | 'FULL_EXIT' | 'IRRELEVANT';
  confidence: number;
  reasoning: string;
  provider: 'anthropic' | 'grok';
  signal?: {
    ticker: string;
    strike: number;
    direction: 'call' | 'put';
    price: number;
  };
  tickers?: string[];
  direction?: 'call' | 'put';
  mentionedGainPercent?: number;
}

const SYSTEM_PROMPT = `You classify messages from a Discord options trading guru into exactly one of 7 types. Respond ONLY with valid JSON.

## Message Types

1. **GAMEPLAN** — The guru's morning plan. Contains tickers he's watching and direction (calls/puts). No specific trade yet.
   Examples: "Todays gameplan $SPY", "The calls im watching", "puts im watching today"

2. **ENTRY** — A specific trade signal with ticker + strike price + entry price. This is a BUY signal.
   Examples: "$IWM Call at $265 at 0.18", "$SPY Call at $570 at 0.15", "3/4 $IWM Call at $265 at 0.09"

3. **SCALE_IN** — Guru is adding to an existing position. NOT a sell signal. Contains "adding", "better fill", or similar.
   Examples: "Adding here @everyone", "You can get a better fill down here", "Adding more"

4. **UPDATE** — Commentary on market action. No trade action needed. Includes pump/dump updates, excitement, general commentary.
   Examples: "Amazing pump so far", "Decent pump but we need a comeback", "Absolutely cooking", "What a move"

5. **PARTIAL_EXIT** — Guru is telling people to sell HALF their position. Must be clearly about selling/taking profits.
   Examples: "You can sell half here to be safe", "Take some profits here", "There's the 120% gain. You guys know what to do"
   IMPORTANT: Only classify as PARTIAL_EXIT if the guru is CLEARLY telling people to sell. "To be safe" alone without selling context is NOT a sell signal.

6. **FULL_EXIT** — Guru is telling people to sell ALL remaining position. Clear "sell all" or "done for the day".
   Examples: "Sell all", "Close everything", "Done for the day", "Get out"

7. **IRRELEVANT** — Anything else: greetings, off-topic chat, promotions, etc.

## Context

You will receive recent message history (if available) to help disambiguate. Use context to:
- Determine the current ticker/direction when a message refers to "the position" or "it" without specifics
- Distinguish SCALE_IN from ENTRY: if a previous message was ENTRY for the same ticker, "adding here" = SCALE_IN
- Better judge sell signals: if recent messages show an ENTRY was made, then "to be safe" + sell language = PARTIAL_EXIT
- Understand the trading day flow: GAMEPLAN -> ENTRY -> UPDATE(s) -> PARTIAL_EXIT -> FULL_EXIT

## Rules

- When in doubt between PARTIAL_EXIT and UPDATE, choose UPDATE (safer — no trade action).
- ENTRY requires a parseable ticker + strike + price. Without all three, it's UPDATE or GAMEPLAN.
- SCALE_IN means the guru is ADDING to his position, not exiting. This is bullish, not bearish.
- If the message contains an image showing a P&L card with a large gain (100%+) AND text suggesting people should act, that's PARTIAL_EXIT.
- If the message is just an image with no clear sell instruction, classify as UPDATE.

## Response Format

Respond with ONLY this JSON (no markdown, no explanation outside the JSON):
{
  "type": "ENTRY",
  "confidence": 0.95,
  "reasoning": "Brief explanation of why this classification",
  "signal": { "ticker": "IWM", "strike": 265, "direction": "call", "price": 0.18 },
  "tickers": ["IWM"],
  "direction": "call",
  "mentionedGainPercent": null
}

The "signal" field is only needed for ENTRY and SCALE_IN types (when a specific ticker+strike+price is mentioned). Set to null otherwise.
The "tickers" field lists any $TICKER symbols found in the text.
The "direction" field is "call" or "put" if mentioned, null otherwise.
The "mentionedGainPercent" is a number if a gain percentage is mentioned (e.g., "120% gain" -> 120), null otherwise.`;

// --- Anthropic Client ---

let anthropicClient: Anthropic | null = null;

function getAnthropicClient(): Anthropic | null {
  if (anthropicClient) return anthropicClient;
  const apiKey = config.llm.anthropicApiKey;
  if (!apiKey) return null;
  anthropicClient = new Anthropic({ apiKey });
  return anthropicClient;
}

async function classifyWithAnthropic(
  text: string,
  imageUrls: string[],
  recentContext: ContextMessage[],
  timeoutMs: number,
): Promise<LLMClassification | null> {
  const client = getAnthropicClient();
  if (!client) return null;

  const content: Anthropic.MessageCreateParams['messages'][0]['content'] = [];

  for (const url of imageUrls.slice(0, 3)) {
    content.push({ type: 'image', source: { type: 'url', url } });
  }

  let userText = '';
  if (recentContext.length > 0) {
    const contextLines = recentContext.map(
      m => `[${m.classification}] "${m.text.substring(0, 100)}"`
    ).join('\n');
    userText += `Recent messages (oldest first):\n${contextLines}\n\nNew message to classify:\n`;
  }
  userText += text || '(no text — image only message)';
  content.push({ type: 'text', text: userText });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content }],
    }, { signal: controller.signal });

    clearTimeout(timeout);

    const rawResponse = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map(block => block.text)
      .join('');

    const cleaned = rawResponse.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(cleaned) as LLMClassification;
    if (!parsed.type || !parsed.confidence) return null;

    parsed.provider = 'anthropic';
    logger.info(`[Anthropic] ${parsed.type} (${(parsed.confidence * 100).toFixed(0)}%): ${parsed.reasoning}`);
    return parsed;
  } catch (err: any) {
    clearTimeout(timeout);
    const reason = err.name === 'AbortError' ? 'timeout' : err.message;
    logger.warn(`[Anthropic] classification failed: ${reason}`);
    throw err;
  }
}

// --- Grok Client ---

let grokClient: OpenAI | null = null;

function getGrokClient(): OpenAI | null {
  if (grokClient) return grokClient;
  const apiKey = config.llm.grokApiKey;
  if (!apiKey) return null;
  grokClient = new OpenAI({ apiKey, baseURL: 'https://api.x.ai/v1' });
  return grokClient;
}

async function classifyWithGrok(
  text: string,
  imageUrls: string[],
  recentContext: ContextMessage[],
  timeoutMs: number,
): Promise<LLMClassification | null> {
  const client = getGrokClient();
  if (!client) return null;

  const contentParts: OpenAI.ChatCompletionContentPart[] = [];

  for (const url of imageUrls.slice(0, 3)) {
    contentParts.push({ type: 'image_url', image_url: { url } });
  }

  let userText = '';
  if (recentContext.length > 0) {
    const contextLines = recentContext.map(
      m => `[${m.classification}] "${m.text.substring(0, 100)}"`
    ).join('\n');
    userText += `Recent messages (oldest first):\n${contextLines}\n\nNew message to classify:\n`;
  }
  userText += text || '(no text — image only message)';
  contentParts.push({ type: 'text', text: userText });

  const model = imageUrls.length > 0 ? 'grok-4-1-fast-non-reasoning' : 'grok-3-mini-fast';

  try {
    const response = await client.chat.completions.create({
      model,
      max_tokens: 300,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: contentParts },
      ],
    }, { timeout: timeoutMs });

    const responseText = response.choices[0]?.message?.content || '';
    const cleaned = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(cleaned) as LLMClassification;
    if (!parsed.type || !parsed.confidence) return null;

    parsed.provider = 'grok';
    logger.info(`[Grok] ${parsed.type} (${(parsed.confidence * 100).toFixed(0)}%): ${parsed.reasoning}`);
    return parsed;
  } catch (err: any) {
    logger.warn(`[Grok] classification failed: ${err.message}`);
    throw err;
  }
}

// --- Public API: Failover classifier ---

export async function classifyWithLLM(
  text: string,
  imageUrls: string[] = [],
  recentContext: ContextMessage[] = [],
): Promise<LLMClassification | null> {
  const timeoutMs = config.llm.classifierTimeoutMs;

  // Try Anthropic first
  if (config.llm.anthropicApiKey) {
    try {
      const result = await classifyWithAnthropic(text, imageUrls, recentContext, timeoutMs);
      if (result && result.confidence >= 0.7) return result;
      if (result) logger.info(`[Anthropic] confidence too low (${(result.confidence * 100).toFixed(0)}%), trying Grok...`);
    } catch {
      logger.info('[Anthropic] failed, falling back to Grok...');
    }
  }

  // Failover to Grok
  if (config.llm.grokApiKey) {
    try {
      const result = await classifyWithGrok(text, imageUrls, recentContext, timeoutMs);
      if (result && result.confidence >= 0.7) return result;
      if (result) logger.info(`[Grok] confidence too low (${(result.confidence * 100).toFixed(0)}%), falling back to regex`);
    } catch {
      logger.info('[Grok] also failed, falling back to regex');
    }
  }

  return null;
}

export function llmClassificationToSignal(
  classification: LLMClassification,
  messageId: string,
  rawText: string
): TradeSignal | undefined {
  if (!classification.signal) return undefined;

  const s = classification.signal;
  if (!s.ticker || !s.strike || !s.price || !s.direction) return undefined;

  return {
    raw: rawText,
    ticker: s.ticker.toUpperCase(),
    direction: s.direction,
    strikePrice: s.strike,
    entryPrice: s.price,
    timestamp: new Date(),
    messageId,
  };
}
