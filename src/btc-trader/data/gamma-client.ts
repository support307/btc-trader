import { btcConfig } from '../config';
import { logger } from '../clock/logger';
import { MarketWindow } from '../types';
import { marketClock } from '../clock/market-clock';

const BASE = btcConfig.polymarket.gammaBaseUrl;

async function gammaFetch(path: string, params?: Record<string, string>): Promise<any> {
  const url = new URL(`${BASE}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Gamma API ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function fetchMarketBySlug(slug: string): Promise<any | null> {
  try {
    const data = await gammaFetch('/markets', { slug });
    if (Array.isArray(data) && data.length > 0) return data[0];
    return null;
  } catch (err: any) {
    logger.warn(`fetchMarketBySlug(${slug}): ${err.message}`);
    return null;
  }
}

export async function fetchMarketById(id: string): Promise<any | null> {
  try {
    const data = await gammaFetch(`/markets/${id}`);
    return data;
  } catch (err: any) {
    logger.warn(`fetchMarketById(${id}): ${err.message}`);
    return null;
  }
}

export async function searchMarkets(query: string, limit = 20): Promise<any[]> {
  try {
    return await gammaFetch('/markets', {
      _q: query,
      limit: String(limit),
      active: 'true',
    });
  } catch (err: any) {
    logger.warn(`searchMarkets(${query}): ${err.message}`);
    return [];
  }
}

export async function fetchWindowOutcome(epoch: number): Promise<MarketWindow | null> {
  const slug = marketClock.buildSlug(epoch);
  const market = await fetchMarketBySlug(slug);
  if (!market) return null;
  return marketClock.parseMarket(market, epoch);
}

export async function fetchBatchWindowOutcomes(
  epochs: number[],
  concurrency = 3,
  delayMs = 350
): Promise<Map<number, MarketWindow>> {
  const results = new Map<number, MarketWindow>();
  let consecutiveErrors = 0;

  for (let i = 0; i < epochs.length; i += concurrency) {
    const batch = epochs.slice(i, i + concurrency);
    const promises = batch.map(async (epoch) => {
      const window = await fetchWindowOutcome(epoch);
      if (window) {
        results.set(epoch, window);
        consecutiveErrors = 0;
      }
    });
    await Promise.all(promises);

    // Progress logging every 100 windows
    if ((i + concurrency) % 100 < concurrency) {
      logger.info(`  Progress: ${Math.min(i + concurrency, epochs.length)}/${epochs.length} windows fetched (${results.size} found)`);
    }

    // Adaptive backoff on errors
    if (consecutiveErrors > 5) {
      const backoff = Math.min(5000, delayMs * consecutiveErrors);
      logger.warn(`Rate limited, backing off ${backoff}ms`);
      await new Promise((r) => setTimeout(r, backoff));
      consecutiveErrors = 0;
    }

    if (i + concurrency < epochs.length) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  logger.info(`Fetched ${results.size}/${epochs.length} window outcomes from Gamma`);
  return results;
}

export async function checkGeoblock(): Promise<{ blocked: boolean; country: string }> {
  try {
    const res = await fetch(btcConfig.polymarket.geoblockUrl);
    const data = await res.json() as any;
    return { blocked: !!data.blocked, country: data.country || 'unknown' };
  } catch {
    return { blocked: false, country: 'unknown' };
  }
}
