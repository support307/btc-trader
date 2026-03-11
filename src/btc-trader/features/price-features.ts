import { OHLCV } from '../types';

export function computeReturn(prices: number[], periodBars: number): number {
  if (prices.length < periodBars + 1) return 0;
  const current = prices[prices.length - 1];
  const past = prices[prices.length - 1 - periodBars];
  if (past === 0) return 0;
  return (current - past) / past;
}

export function computeVolatility(prices: number[]): number {
  if (prices.length < 3) return 0;
  const returns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1] === 0) continue;
    returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
  }
  if (returns.length < 2) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance);
}

export function computeMomentum(candles: OHLCV[], periods: number): number {
  if (candles.length < periods + 1) return 0;
  let upCount = 0;
  let downCount = 0;
  const recent = candles.slice(-periods);
  for (const c of recent) {
    if (c.close > c.open) upCount++;
    else if (c.close < c.open) downCount++;
  }
  return (upCount - downCount) / periods;
}

export function computeRSI(prices: number[], period = 14): number {
  if (prices.length < period + 1) return 50;
  let gainSum = 0;
  let lossSum = 0;
  const slice = prices.slice(-(period + 1));
  for (let i = 1; i < slice.length; i++) {
    const change = slice[i] - slice[i - 1];
    if (change > 0) gainSum += change;
    else lossSum += Math.abs(change);
  }
  const avgGain = gainSum / period;
  const avgLoss = lossSum / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function computeEMA(prices: number[], period: number): number {
  if (prices.length === 0) return 0;
  const k = 2 / (period + 1);
  let ema = prices[0];
  for (let i = 1; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

export function priceChangeFromWindowStart(
  candles: OHLCV[],
  windowStartMs: number
): number {
  const startCandle = candles.find((c) => c.timestamp >= windowStartMs);
  if (!startCandle || candles.length === 0) return 0;
  const currentPrice = candles[candles.length - 1].close;
  const startPrice = startCandle.open;
  if (startPrice === 0) return 0;
  return (currentPrice - startPrice) / startPrice;
}

export function extractClosePrices(candles: OHLCV[]): number[] {
  return candles.map((c) => c.close);
}
