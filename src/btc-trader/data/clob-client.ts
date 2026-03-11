import { btcConfig } from '../config';
import { logger } from '../clock/logger';
import { OrderbookSnapshot, OrderbookLevel } from '../types';

const CLOB_BASE = btcConfig.polymarket.clobBaseUrl;

async function clobFetch(path: string, params?: Record<string, string>): Promise<any> {
  const url = new URL(`${CLOB_BASE}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`CLOB API ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function fetchOrderbook(tokenId: string): Promise<OrderbookSnapshot> {
  const data = await clobFetch('/book', { token_id: tokenId });
  return {
    timestamp: Date.now(),
    tokenId,
    bids: (data.bids || []).map((b: any) => ({
      price: parseFloat(b.price),
      size: parseFloat(b.size),
    })),
    asks: (data.asks || []).map((a: any) => ({
      price: parseFloat(a.price),
      size: parseFloat(a.size),
    })),
  };
}

export async function fetchMidpoint(tokenId: string): Promise<number | null> {
  try {
    const data = await clobFetch('/midpoint', { token_id: tokenId });
    return data.mid ? parseFloat(data.mid) : null;
  } catch {
    return null;
  }
}

export async function fetchSpread(tokenId: string): Promise<{ bid: number; ask: number } | null> {
  try {
    const data = await clobFetch('/spread', { token_id: tokenId });
    return {
      bid: parseFloat(data.bid || '0'),
      ask: parseFloat(data.ask || '0'),
    };
  } catch {
    return null;
  }
}

export async function fetchPriceHistory(
  tokenId: string,
  startTs: number,
  endTs: number,
  interval = '1m',
  fidelity = 1
): Promise<Array<{ t: number; p: number }>> {
  try {
    const minFidelity = interval === '1m' ? 10 : fidelity;
    const data = await clobFetch('/prices-history', {
      market: tokenId,
      startTs: String(startTs),
      endTs: String(endTs),
      interval,
      fidelity: String(minFidelity),
    });
    if (!data.history) return [];
    return data.history.map((h: any) => ({
      t: h.t,
      p: parseFloat(h.p),
    }));
  } catch (err: any) {
    logger.warn(`fetchPriceHistory error: ${err.message}`);
    return [];
  }
}

export function bestBid(book: OrderbookSnapshot): number {
  if (book.bids.length === 0) return 0;
  return Math.max(...book.bids.map((b) => b.price));
}

export function bestAsk(book: OrderbookSnapshot): number {
  if (book.asks.length === 0) return 1;
  return Math.min(...book.asks.map((a) => a.price));
}

export function midPrice(book: OrderbookSnapshot): number {
  const bid = bestBid(book);
  const ask = bestAsk(book);
  return (bid + ask) / 2;
}

export function spread(book: OrderbookSnapshot): number {
  return bestAsk(book) - bestBid(book);
}

export function depthImbalance(book: OrderbookSnapshot, levels = 5): number {
  const bidDepth = book.bids.slice(0, levels).reduce((s, b) => s + b.size, 0);
  const askDepth = book.asks.slice(0, levels).reduce((s, a) => s + a.size, 0);
  const total = bidDepth + askDepth;
  if (total === 0) return 0;
  return (bidDepth - askDepth) / total;
}
