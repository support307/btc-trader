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
