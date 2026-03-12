import WebSocket from 'ws';
import { btcConfig } from '../config';
import { logger } from '../clock/logger';
import { PriceTick, OHLCV } from '../types';

interface SignedTick extends PriceTick {
  isBuyerAggressor: boolean;
}

const MAX_TICKS = 5000;
const RECONNECT_DELAY = 3000;

export class BinancePriceFeed {
  private ws: WebSocket | null = null;
  private ticks: PriceTick[] = [];
  private signedTicks: SignedTick[] = [];
  private latestPrice = 0;
  private connected = false;
  private reconnectTimer: NodeJS.Timeout | null = null;

  get price(): number { return this.latestPrice; }
  get isConnected(): boolean { return this.connected; }

  start(): void {
    this.connect();
  }

  stop(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }

  private connect(): void {
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
    }

    this.ws = new WebSocket(btcConfig.binance.wsUrl);

    this.ws.on('open', () => {
      this.connected = true;
      logger.info('Binance BTC/USDT WebSocket connected');
    });

    this.ws.on('message', (raw: Buffer) => {
      try {
        const data = JSON.parse(raw.toString());
        const tick: PriceTick = {
          timestamp: data.T || Date.now(),
          price: parseFloat(data.p),
          volume: parseFloat(data.q),
        };
        // Binance: m=true means buyer is maker, so aggressor is seller.
        const isBuyerAggressor = data.m === false;
        this.latestPrice = tick.price;
        this.ticks.push(tick);
        this.signedTicks.push({ ...tick, isBuyerAggressor });
        if (this.ticks.length > MAX_TICKS) {
          this.ticks = this.ticks.slice(-MAX_TICKS);
        }
        if (this.signedTicks.length > MAX_TICKS) {
          this.signedTicks = this.signedTicks.slice(-MAX_TICKS);
        }
      } catch { /* skip malformed messages */ }
    });

    this.ws.on('close', () => {
      this.connected = false;
      logger.warn('Binance WebSocket closed, reconnecting...');
      this.scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      logger.error(`Binance WebSocket error: ${err.message}`);
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, RECONNECT_DELAY);
  }

  getTicksSince(sinceMs: number): PriceTick[] {
    return this.ticks.filter((t) => t.timestamp >= sinceMs);
  }

  getTicksInRange(startMs: number, endMs: number): PriceTick[] {
    return this.ticks.filter((t) => t.timestamp >= startMs && t.timestamp <= endMs);
  }

  getPriceAtTime(targetMs: number): number | null {
    let closest: PriceTick | null = null;
    let minDiff = Infinity;
    for (const t of this.ticks) {
      const diff = Math.abs(t.timestamp - targetMs);
      if (diff < minDiff) {
        minDiff = diff;
        closest = t;
      }
    }
    return closest && minDiff < 30_000 ? closest.price : null;
  }

  buildCandles(intervalMs: number, count: number): OHLCV[] {
    const now = Date.now();
    const candles: OHLCV[] = [];
    for (let i = count - 1; i >= 0; i--) {
      const start = now - (i + 1) * intervalMs;
      const end = now - i * intervalMs;
      const windowTicks = this.ticks.filter(
        (t) => t.timestamp >= start && t.timestamp < end
      );
      if (windowTicks.length === 0) continue;
      candles.push({
        timestamp: start,
        open: windowTicks[0].price,
        high: Math.max(...windowTicks.map((t) => t.price)),
        low: Math.min(...windowTicks.map((t) => t.price)),
        close: windowTicks[windowTicks.length - 1].price,
        volume: windowTicks.reduce((s, t) => s + (t.volume || 0), 0),
      });
    }
    return candles;
  }

  getReturn(periodMs: number): number {
    if (this.ticks.length < 2 || !this.latestPrice) return 0;
    const pastPrice = this.getPriceAtTime(Date.now() - periodMs);
    if (!pastPrice) return 0;
    return (this.latestPrice - pastPrice) / pastPrice;
  }

  getVolatility(periodMs: number, sampleIntervalMs = 10_000): number {
    const now = Date.now();
    const since = now - periodMs;
    const samples: number[] = [];
    for (let t = since; t <= now; t += sampleIntervalMs) {
      const p = this.getPriceAtTime(t);
      if (p) samples.push(p);
    }
    if (samples.length < 3) return 0;
    const returns: number[] = [];
    for (let i = 1; i < samples.length; i++) {
      returns.push((samples[i] - samples[i - 1]) / samples[i - 1]);
    }
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
    return Math.sqrt(variance);
  }

  /**
   * Trade Flow Imbalance: (buyVolume - sellVolume) / (buyVolume + sellVolume).
   * Range: -1 (all sells) to +1 (all buys).
   */
  getTradeFlowImbalance(windowMs: number): number {
    const cutoff = Date.now() - windowMs;
    let buyVol = 0;
    let sellVol = 0;
    for (let i = this.signedTicks.length - 1; i >= 0; i--) {
      const t = this.signedTicks[i];
      if (t.timestamp < cutoff) break;
      const vol = (t.volume || 0) * t.price;
      if (t.isBuyerAggressor) buyVol += vol;
      else sellVol += vol;
    }
    const total = buyVol + sellVol;
    if (total === 0) return 0;
    return (buyVol - sellVol) / total;
  }

  /**
   * Volume surge: ratio of recent window volume to a longer baseline average.
   * Returns >1 when current volume is above average, >2 = notable surge.
   */
  getVolumeSurge(windowMs: number, baselineMs: number): number {
    const now = Date.now();
    const recentCutoff = now - windowMs;
    const baselineCutoff = now - baselineMs;

    let recentVol = 0;
    let baselineVol = 0;
    for (let i = this.signedTicks.length - 1; i >= 0; i--) {
      const t = this.signedTicks[i];
      if (t.timestamp < baselineCutoff) break;
      const vol = (t.volume || 0) * t.price;
      baselineVol += vol;
      if (t.timestamp >= recentCutoff) recentVol += vol;
    }

    if (baselineVol === 0) return 0;
    const baselineRate = baselineVol / baselineMs;
    const recentRate = recentVol / windowMs;
    if (baselineRate === 0) return 0;
    return recentRate / baselineRate;
  }

  /**
   * VWAP since a given timestamp. Returns 0 if no ticks in range.
   */
  getVWAP(sinceMs: number): number {
    let cumPriceVol = 0;
    let cumVol = 0;
    for (let i = this.signedTicks.length - 1; i >= 0; i--) {
      const t = this.signedTicks[i];
      if (t.timestamp < sinceMs) break;
      const vol = t.volume || 0;
      cumPriceVol += t.price * vol;
      cumVol += vol;
    }
    if (cumVol === 0) return 0;
    return cumPriceVol / cumVol;
  }

  /**
   * VWAP deviation: (currentPrice - vwap) / currentPrice. Positive = price above VWAP.
   */
  getVWAPDeviation(sinceMs: number): number {
    const vwap = this.getVWAP(sinceMs);
    if (vwap === 0 || this.latestPrice === 0) return 0;
    return (this.latestPrice - vwap) / this.latestPrice;
  }
}

export async function fetchBinanceKlines(
  symbol: string,
  interval: string,
  startTime: number,
  endTime: number,
  limit = 1000
): Promise<OHLCV[]> {
  // Try Binance US first, then international Binance, then CoinGecko as fallback
  const endpoints = [
    `https://api.binance.us/api/v3/klines`,
    `${btcConfig.binance.restUrl}/api/v3/klines`,
  ];

  for (const baseUrl of endpoints) {
    try {
      const url = new URL(baseUrl);
      url.searchParams.set('symbol', symbol);
      url.searchParams.set('interval', interval);
      url.searchParams.set('startTime', String(startTime));
      url.searchParams.set('endTime', String(endTime));
      url.searchParams.set('limit', String(limit));

      const res = await fetch(url.toString(), { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) continue;
      const data = await res.json() as any[];

      return data.map((k: any[]) => ({
        timestamp: k[0],
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
      }));
    } catch {
      continue;
    }
  }

  // Fallback: CoinGecko market_chart/range (limited granularity)
  return fetchCoinGeckoCandles(startTime, endTime);
}

async function fetchCoinGeckoCandles(startMs: number, endMs: number): Promise<OHLCV[]> {
  try {
    const startSec = Math.floor(startMs / 1000);
    const endSec = Math.floor(endMs / 1000);
    const url = `https://api.coingecko.com/api/v3/coins/bitcoin/market_chart/range?vs_currency=usd&from=${startSec}&to=${endSec}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
    const data = await res.json() as any;
    const prices: Array<[number, number]> = data.prices || [];

    const candles: OHLCV[] = [];
    for (let i = 0; i < prices.length - 1; i++) {
      const [ts, price] = prices[i];
      const [, nextPrice] = prices[i + 1];
      candles.push({
        timestamp: ts,
        open: price,
        high: Math.max(price, nextPrice),
        low: Math.min(price, nextPrice),
        close: nextPrice,
        volume: 0,
      });
    }
    return candles;
  } catch (err: any) {
    logger.warn(`CoinGecko fallback failed: ${err.message}`);
    return [];
  }
}
