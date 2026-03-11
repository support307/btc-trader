import { OrderbookSnapshot } from '../types';
import { bestBid, bestAsk, spread, depthImbalance, midPrice } from '../data/clob-client';

export interface OrderbookFeatures {
  bidAskSpread: number;
  depthImbalance: number;
  impliedProb: number;
  bestBidPrice: number;
  bestAskPrice: number;
  midPriceVal: number;
  totalBidDepth: number;
  totalAskDepth: number;
}

export function extractOrderbookFeatures(book: OrderbookSnapshot): OrderbookFeatures {
  const bb = bestBid(book);
  const ba = bestAsk(book);
  const mid = midPrice(book);
  const sp = spread(book);
  const imbalance = depthImbalance(book, 5);
  const totalBidDepth = book.bids.reduce((s, b) => s + b.size, 0);
  const totalAskDepth = book.asks.reduce((s, a) => s + a.size, 0);

  return {
    bidAskSpread: sp,
    depthImbalance: imbalance,
    impliedProb: mid,
    bestBidPrice: bb,
    bestAskPrice: ba,
    midPriceVal: mid,
    totalBidDepth,
    totalAskDepth,
  };
}

export function combinedImpliedProb(
  upBook: OrderbookSnapshot | null,
  downBook: OrderbookSnapshot | null
): { probUp: number; probDown: number } {
  const upMid = upBook ? midPrice(upBook) : 0.5;
  const downMid = downBook ? midPrice(downBook) : 0.5;
  const total = upMid + downMid;
  if (total === 0) return { probUp: 0.5, probDown: 0.5 };
  return {
    probUp: upMid / total,
    probDown: downMid / total,
  };
}

export function arbitrageSpread(
  upBook: OrderbookSnapshot | null,
  downBook: OrderbookSnapshot | null
): number {
  if (!upBook || !downBook) return 0;
  const upAsk = bestAsk(upBook);
  const downAsk = bestAsk(downBook);
  return 1.0 - upAsk - downAsk;
}
