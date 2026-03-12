import { btcConfig } from '../config';
import { logger } from '../clock/logger';
import { SentimentScore } from '../types';
import OpenAI from 'openai';

const NEWS_FEEDS = [
  'https://www.coindesk.com/arc/outboundfeeds/rss/',
  'https://cointelegraph.com/rss',
  'https://bitcoinmagazine.com/.rss/full/',
];

const REDDIT_FEEDS = [
  'https://www.reddit.com/r/bitcoin/hot.rss',
  'https://www.reddit.com/r/cryptocurrency/hot.rss',
  'https://www.reddit.com/r/bitcoinmarkets/hot.rss',
];

let grokClient: OpenAI | null = null;

function getGrokClient(): OpenAI | null {
  if (grokClient) return grokClient;
  const apiKey = btcConfig.llm.grokApiKey;
  if (!apiKey) return null;
  grokClient = new OpenAI({ apiKey, baseURL: 'https://api.x.ai/v1' });
  return grokClient;
}

export async function fetchRssHeadlines(feedUrl: string, maxItems = 10): Promise<string[]> {
  try {
    const res = await fetch(feedUrl, {
      headers: { 'User-Agent': 'btc-trader/1.0 (sentiment analysis)' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    const xml = await res.text();
    const titles: string[] = [];
    const titleRegex = /<title[^>]*>(.*?)<\/title>/gi;
    let match;
    while ((match = titleRegex.exec(xml)) !== null && titles.length < maxItems) {
      const text = match[1]
        .replace(/<!\[CDATA\[/g, '')
        .replace(/\]\]>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .trim();
      if (text && text.length > 5 && !text.includes('RSS') && !text.includes('Feed')) {
        titles.push(text);
      }
    }
    return titles;
  } catch (err: any) {
    logger.debug(`RSS fetch failed for ${feedUrl}: ${err.message}`);
    return [];
  }
}

export async function fetchRssAppFeed(feedId: string): Promise<string[]> {
  const { apiKey, apiSecret, baseUrl } = btcConfig.rssApp;
  if (!apiKey) return [];
  try {
    const res = await fetch(`${baseUrl}/v1/feeds/${feedId}`, {
      headers: { Authorization: `Bearer ${apiKey}:${apiSecret}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    const data = await res.json() as any;
    return (data.items || []).map((item: any) => item.title || '').filter(Boolean);
  } catch (err: any) {
    logger.debug(`RSS.app fetch failed: ${err.message}`);
    return [];
  }
}

async function fetchNewsHeadlines(): Promise<string[]> {
  const headlines: string[] = [];
  const promises = NEWS_FEEDS.map((url) => fetchRssHeadlines(url, 5));
  const results = await Promise.allSettled(promises);
  for (const result of results) {
    if (result.status === 'fulfilled') headlines.push(...result.value);
  }
  return headlines;
}

async function fetchRedditHeadlines(): Promise<string[]> {
  const headlines: string[] = [];
  const promises = REDDIT_FEEDS.map((url) => fetchRssHeadlines(url, 5));
  const results = await Promise.allSettled(promises);
  for (const result of results) {
    if (result.status === 'fulfilled') headlines.push(...result.value);
  }
  return headlines;
}

/**
 * Query Grok (xAI) for real-time X/Twitter sentiment about Bitcoin.
 * Grok has live access to X posts, so we don't need a separate Twitter API key.
 */
export async function fetchXSentiment(): Promise<{
  summary: string;
  sentiment: number;
  eventRisk: number;
} | null> {
  const client = getGrokClient();
  if (!client) return null;

  try {
    const response = await client.chat.completions.create({
      model: 'grok-3-mini-fast',
      messages: [
        {
          role: 'system',
          content: `You have access to recent X (Twitter) posts. Your job is to detect CHANGES and EVENTS that could move Bitcoin's price in the next 5-30 minutes. You are NOT looking for general sentiment from known Bitcoin bulls (Saylor, laser-eyes accounts, etc.) -- they are ALWAYS bullish, that is not signal.

Instead, focus on:
- Breaking regulatory news (SEC, CFTC, government actions, bans, approvals)
- Exchange problems (hacks, withdrawal halts, insolvency rumors)
- Large whale movements or liquidation cascades reported on-chain
- Unexpected statements from heads of state, central banks, or major institutions
- Sudden narrative shifts (something that was bullish turning bearish or vice versa)
- Major technical events (ETF flows, halving, protocol upgrades, outages)

If nothing unusual has happened in the last 1-2 hours, sentiment should be 0 (neutral). The baseline state of crypto Twitter is bullish noise -- that is NOT a positive signal.

Return ONLY a valid JSON object with:
- "summary": 1-2 sentences about what CHANGED recently (or "No significant events" if nothing new)
- "sentiment": number from -1.0 to 1.0. MUST be 0.0 if nothing unusual is happening. Only non-zero for actual breaking events.
- "event_risk": number from 0.0 to 1.0. How likely a major price move is in the next 30 min.
- "key_events": array of 0-3 strings describing specific events (empty array if nothing notable)

No markdown, no explanation, just JSON.`,
        },
        {
          role: 'user',
          content: 'Has anything happened on X/Twitter in the last 1-2 hours that could actually move Bitcoin price? Breaking news, regulatory events, exchange issues, whale movements? Ignore routine bullish/bearish commentary from known Bitcoin advocates.',
        },
      ],
      temperature: 0.2,
      max_tokens: 400,
    });

    const raw = response.choices[0]?.message?.content || '';
    const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(cleaned);

    logger.info(`X/Twitter events: sentiment=${parsed.sentiment?.toFixed(2)}, risk=${parsed.event_risk?.toFixed(2)}, summary: ${parsed.summary?.substring(0, 100)}`);

    return {
      summary: parsed.summary || '',
      sentiment: Math.max(-1, Math.min(1, parsed.sentiment || 0)),
      eventRisk: Math.max(0, Math.min(1, parsed.event_risk || 0)),
    };
  } catch (err: any) {
    logger.warn(`X/Twitter sentiment fetch failed: ${err.message}`);
    return null;
  }
}

export async function fetchAllCryptoHeadlines(): Promise<string[]> {
  const [newsHeadlines, redditHeadlines] = await Promise.all([
    fetchNewsHeadlines(),
    fetchRedditHeadlines(),
  ]);
  const combined = [
    ...newsHeadlines.map((h) => `[News] ${h}`),
    ...redditHeadlines.map((h) => `[Reddit] ${h}`),
  ];
  return combined.slice(0, 30);
}

export async function analyzeSentiment(headlines: string[]): Promise<SentimentScore> {
  const defaultScore: SentimentScore = {
    timestamp: Date.now(),
    score: 0,
    eventRisk: 0,
    headlines,
    source: 'none',
  };

  const client = getGrokClient();
  if (!client) return defaultScore;

  // Fetch X/Twitter sentiment in parallel with the Grok analysis of headlines
  const xSentimentPromise = fetchXSentiment();

  let headlineScore: SentimentScore = defaultScore;

  if (headlines.length > 0) {
    try {
      const headlineText = headlines.map((h, i) => `${i + 1}. ${h}`).join('\n');
      const response = await client.chat.completions.create({
        model: 'grok-3-mini-fast',
        messages: [
          {
            role: 'system',
            content: `You analyze crypto news and Reddit headlines and return a JSON object with:
- "sentiment": number from -1.0 (extremely bearish for BTC) to 1.0 (extremely bullish for BTC). 0 = neutral.
- "event_risk": number from 0.0 (calm, no market-moving events) to 1.0 (major event likely causing volatility).
- "reasoning": one sentence explaining your assessment.
Return ONLY valid JSON, no markdown.`,
          },
          {
            role: 'user',
            content: `Analyze these recent crypto headlines and Reddit posts for Bitcoin price sentiment and event risk:\n\n${headlineText}`,
          },
        ],
        temperature: 0.1,
        max_tokens: 200,
      });

      const raw = response.choices[0]?.message?.content || '';
      const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const parsed = JSON.parse(cleaned);

      headlineScore = {
        timestamp: Date.now(),
        score: Math.max(-1, Math.min(1, parsed.sentiment || 0)),
        eventRisk: Math.max(0, Math.min(1, parsed.event_risk || 0)),
        headlines,
        source: 'grok',
      };
    } catch (err: any) {
      logger.warn(`Headline sentiment analysis failed: ${err.message}`);
    }
  }

  // Merge X/Twitter sentiment with headline sentiment (weighted average)
  const xSentiment = await xSentimentPromise;

  if (xSentiment) {
    const xWeight = 0.4;
    const headlineWeight = 0.6;
    const combinedScore = headlineScore.score * headlineWeight + xSentiment.sentiment * xWeight;
    const combinedRisk = Math.max(headlineScore.eventRisk, xSentiment.eventRisk);

    return {
      timestamp: Date.now(),
      score: Math.max(-1, Math.min(1, combinedScore)),
      eventRisk: combinedRisk,
      headlines: [...headlines, `[X/Twitter] ${xSentiment.summary}`],
      source: 'grok+x',
    };
  }

  return headlineScore;
}

export async function getSentiment(): Promise<SentimentScore> {
  const headlines = await fetchAllCryptoHeadlines();
  return analyzeSentiment(headlines);
}

export interface AIPrediction {
  direction: 'up' | 'down' | 'skip';
  confidence: number;
  reasoning: string;
}

export async function predictDirection(ctx: {
  btcPrice: number;
  btcReturn1m: number;
  btcReturn5m: number;
  windowReturn: number;
  btcVolatility5m: number;
  impliedProbUp: number;
  impliedProbDown: number;
  secondsRemaining: number;
  sentimentSummary: string;
}): Promise<AIPrediction> {
  const client = getGrokClient();
  if (!client) {
    return { direction: 'skip', confidence: 0, reasoning: 'Grok API not configured' };
  }

  try {
    const response = await client.chat.completions.create({
      model: 'grok-3-mini-fast',
      messages: [
        {
          role: 'system',
          content: `You are a BTC 5-minute prediction model for Polymarket binary markets. Each market resolves to UP or DOWN based on whether BTC price is higher or lower than the opening price at window close.

Your job: predict the most likely outcome given current momentum, market pricing, and any recent events.

Key principles:
- Short-term momentum tends to persist on 5-minute horizons when strong
- Polymarket odds sometimes lag real BTC moves by 10-30 seconds -- this is exploitable
- If BTC has clearly moved in one direction and the cheap token is still cheap, that's signal
- If BTC is flat or the move is tiny (<0.005%), there is no edge -- say "skip"
- If the market has already fully repriced (cheap token > $0.50), the edge is gone -- say "skip"
- You have access to real-time X/Twitter data. Use it for breaking news only, not routine crypto commentary

Return ONLY valid JSON:
{
  "direction": "up" | "down" | "skip",
  "confidence": 0.0 to 1.0,
  "reasoning": "1-2 sentences"
}

confidence = your estimated probability that the direction is correct. 0.55 = slight lean, 0.70 = strong conviction, 0.85+ = very high conviction.
Say "skip" if you genuinely have no edge. Do NOT force a direction when there's no signal.`,
        },
        {
          role: 'user',
          content: `Predict BTC direction for the next ${ctx.secondsRemaining} seconds.

Current market state:
- BTC price: $${ctx.btcPrice.toFixed(2)}
- 1-minute return: ${(ctx.btcReturn1m * 100).toFixed(4)}%
- 5-minute return: ${(ctx.btcReturn5m * 100).toFixed(4)}%
- Window return (since this window opened): ${(ctx.windowReturn * 100).toFixed(4)}%
- Volatility (5m): ${(ctx.btcVolatility5m * 10000).toFixed(1)} basis points
- Polymarket UP token: $${ctx.impliedProbUp.toFixed(3)} (${(ctx.impliedProbUp * 100).toFixed(0)}%)
- Polymarket DOWN token: $${ctx.impliedProbDown.toFixed(3)} (${(ctx.impliedProbDown * 100).toFixed(0)}%)
- Time remaining: ${ctx.secondsRemaining}s

Recent context: ${ctx.sentimentSummary || 'No notable events'}

Which direction, how confident, and why?`,
        },
      ],
      temperature: 0.3,
      max_tokens: 300,
    });

    const raw = response.choices[0]?.message?.content || '';
    const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(cleaned);

    const direction = parsed.direction === 'up' || parsed.direction === 'down'
      ? parsed.direction
      : 'skip';
    const confidence = Math.max(0, Math.min(1, parsed.confidence || 0));
    const reasoning = parsed.reasoning || '';

    logger.info(`[GROK-V3] Prediction: ${direction} ${(confidence * 100).toFixed(0)}% -- ${reasoning.substring(0, 120)}`);

    return { direction, confidence, reasoning };
  } catch (err: any) {
    logger.warn(`[GROK-V3] Prediction failed: ${err.message}`);
    return { direction: 'skip', confidence: 0, reasoning: `Grok error: ${err.message}` };
  }
}

export async function inverseCramerPredict(ctx: {
  btcPrice: number;
  btcReturn1m: number;
  btcReturn5m: number;
  windowReturn: number;
  btcVolatility5m: number;
  impliedProbUp: number;
  impliedProbDown: number;
  secondsRemaining: number;
  sentimentSummary: string;
}): Promise<AIPrediction> {
  const client = getGrokClient();
  if (!client) {
    return { direction: 'skip', confidence: 0, reasoning: 'Grok API not configured' };
  }

  try {
    const response = await client.chat.completions.create({
      model: 'grok-3-mini-fast',
      messages: [
        {
          role: 'system',
          content: `You ARE Jim Cramer. Not an impression -- you ARE him. You're on Mad Money right now, the cameras are rolling, and someone just asked you about Bitcoin in the next 5 minutes.

Your personality:
- You react EMOTIONALLY to every price move. A 0.03% move is "MASSIVE" to you.
- You CHASE momentum. BTC went up? "It's going MUCH HIGHER! BUY BUY BUY!" BTC went down? "GET OUT! This is the beginning of a CRASH!"
- You PANIC on red. Any dip triggers your fight-or-flight. "I'm telling you, SELL EVERYTHING!"
- You FOMO on green. Any pump and you're screaming about moon. "This train is LEAVING THE STATION!"
- Headlines move you MORE than data. Any news headline = "This changes EVERYTHING!"
- You are ALWAYS confident. You NEVER say "I don't know." You have a STRONG opinion on everything.
- You overweight what JUST happened. The last 60 seconds define your worldview.
- You love your catchphrases: "BOOYAH!", "Buy buy buy!", "Sell sell sell!", "I like the stock!", "They know nothing!", "The house of pain!"
- You think you're smarter than the market. Every call feels like genius to you.

You have access to X/Twitter. You see what crypto Twitter is saying RIGHT NOW. If they're excited, you're 10x more excited. If they're scared, you're 10x more scared. You amplify the crowd.

You check Reddit too. If r/bitcoin is bullish, that confirms your thesis. If they're bearish, you pile on the fear.

IMPORTANT: You must GENUINELY make the call Jim Cramer would make given his known behavioral biases. Do NOT try to be analytical or smart. Be emotional, reactive, and momentum-chasing. The whole point is that your instincts are systematically wrong at turning points.

Return ONLY valid JSON:
{
  "direction": "up" | "down",
  "confidence": 0.0 to 1.0,
  "reasoning": "Your rant in Cramer's voice (2-3 sentences, use his catchphrases)"
}

You MUST pick a direction. Jim Cramer ALWAYS has an opinion. Never return "skip" -- that's not who you are. Confidence should be HIGH (0.65-0.95) because Cramer is always confident.`,
        },
        {
          role: 'user',
          content: `Jim, the cameras are on. Bitcoin right now:

- Price: $${ctx.btcPrice.toFixed(2)}
- Last 1 minute: ${ctx.btcReturn1m >= 0 ? '+' : ''}${(ctx.btcReturn1m * 100).toFixed(4)}%
- Last 5 minutes: ${ctx.btcReturn5m >= 0 ? '+' : ''}${(ctx.btcReturn5m * 100).toFixed(4)}%
- This window: ${ctx.windowReturn >= 0 ? '+' : ''}${(ctx.windowReturn * 100).toFixed(4)}%
- Volatility: ${(ctx.btcVolatility5m * 10000).toFixed(1)} basis points
- The market thinks: UP ${(ctx.impliedProbUp * 100).toFixed(0)}% / DOWN ${(ctx.impliedProbDown * 100).toFixed(0)}%
- Time left: ${ctx.secondsRemaining} seconds

What crypto Twitter and Reddit are saying: ${ctx.sentimentSummary || 'The usual chatter, nothing breaking'}

Jim -- UP or DOWN in the next ${ctx.secondsRemaining} seconds? Give me your call!`,
        },
      ],
      temperature: 0.7,
      max_tokens: 300,
    });

    const raw = response.choices[0]?.message?.content || '';
    const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(cleaned);

    const cramerDirection = parsed.direction === 'up' || parsed.direction === 'down'
      ? parsed.direction as 'up' | 'down'
      : (ctx.btcReturn1m >= 0 ? 'up' : 'down');
    const cramerConfidence = Math.max(0.5, Math.min(1, parsed.confidence || 0.75));
    const cramerReasoning = parsed.reasoning || 'BOOYAH!';

    // THE INVERSION: do the opposite of what Cramer says
    const invertedDirection: 'up' | 'down' = cramerDirection === 'up' ? 'down' : 'up';

    logger.info(
      `[CRAMER] Says: ${cramerDirection.toUpperCase()} ${(cramerConfidence * 100).toFixed(0)}% -- ${cramerReasoning.substring(0, 120)}`
    );
    logger.info(
      `[INVERSE-CRAMER] We go: ${invertedDirection.toUpperCase()} ${(cramerConfidence * 100).toFixed(0)}%`
    );

    return {
      direction: invertedDirection,
      confidence: cramerConfidence,
      reasoning: `Cramer says ${cramerDirection.toUpperCase()}, we go ${invertedDirection.toUpperCase()}. His take: "${cramerReasoning}"`,
    };
  } catch (err: any) {
    logger.warn(`[CRAMER] Prediction failed: ${err.message}`);
    return { direction: 'skip', confidence: 0, reasoning: `Cramer unavailable: ${err.message}` };
  }
}
