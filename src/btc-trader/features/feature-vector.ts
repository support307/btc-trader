import { FeatureVector, OHLCV, OrderbookSnapshot, SentimentScore } from '../types';
import {
  computeReturn, computeVolatility, computeMomentum,
  extractClosePrices, priceChangeFromWindowStart,
} from './price-features';
import { extractOrderbookFeatures, combinedImpliedProb } from './orderbook-features';
import { MicrostructureState } from './microstructure-features';

export interface FeatureBuildContext {
  btcCandles: OHLCV[];
  windowEpoch: number;
  currentTimeMs: number;
  upBook: OrderbookSnapshot | null;
  downBook: OrderbookSnapshot | null;
  sentiment: SentimentScore | null;
  priceFeedReturn5m?: number;
  priceFeedReturn1m?: number;
  microstructure?: MicrostructureState | null;
}

export function buildFeatureVector(ctx: FeatureBuildContext): FeatureVector {
  const windowStartMs = ctx.windowEpoch * 1000;
  const secondsIntoWindow = Math.floor((ctx.currentTimeMs - windowStartMs) / 1000);
  const closePrices = extractClosePrices(ctx.btcCandles);
  const btcPrice = closePrices.length > 0 ? closePrices[closePrices.length - 1] : 0;

  const candleReturn1m = computeReturn(closePrices, 1);
  const candleReturn5m = computeReturn(closePrices, 5);
  const btcReturn15m = computeReturn(closePrices, 15);

  const btcReturn1m = candleReturn1m !== 0 ? candleReturn1m : (ctx.priceFeedReturn1m ?? 0);
  const btcReturn5m = candleReturn5m !== 0 ? candleReturn5m : (ctx.priceFeedReturn5m ?? 0);

  const windowReturn = priceChangeFromWindowStart(ctx.btcCandles, windowStartMs)
    || btcReturn5m;

  const last5 = closePrices.slice(-5);
  const last60 = closePrices.slice(-60);
  const btcVolatility1m = computeVolatility(last5);
  const btcVolatility5m = computeVolatility(last60);

  const btcMomentum = computeMomentum(ctx.btcCandles, Math.min(5, ctx.btcCandles.length));

  let bookBidAskSpreadUp = 0;
  let bookBidAskSpreadDown = 0;
  let bookDepthImbalanceUp = 0;
  let bookDepthImbalanceDown = 0;

  if (ctx.upBook) {
    const upFeats = extractOrderbookFeatures(ctx.upBook);
    bookBidAskSpreadUp = upFeats.bidAskSpread;
    bookDepthImbalanceUp = upFeats.depthImbalance;
  }
  if (ctx.downBook) {
    const downFeats = extractOrderbookFeatures(ctx.downBook);
    bookBidAskSpreadDown = downFeats.bidAskSpread;
    bookDepthImbalanceDown = downFeats.depthImbalance;
  }

  const implied = combinedImpliedProb(ctx.upBook, ctx.downBook);

  const dt = new Date(ctx.currentTimeMs);
  const hourOfDay = dt.getUTCHours();
  const dayOfWeek = dt.getUTCDay();
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

  const micro = ctx.microstructure;

  return {
    timestamp: ctx.currentTimeMs,
    windowEpoch: ctx.windowEpoch,
    secondsIntoWindow,
    btcPrice,
    btcReturn1m,
    btcReturn5m,
    btcReturn15m,
    windowReturn,
    btcVolatility1m,
    btcVolatility5m,
    btcMomentum,
    bookBidAskSpreadUp,
    bookBidAskSpreadDown,
    bookDepthImbalanceUp,
    bookDepthImbalanceDown,
    impliedProbUp: implied.probUp,
    impliedProbDown: implied.probDown,
    sentimentScore: ctx.sentiment?.score || 0,
    eventRisk: ctx.sentiment?.eventRisk || 0,
    hourOfDay,
    dayOfWeek,
    isWeekend,
    ...(micro ? {
      ofi30s: micro.ofi30s,
      ofi60s: micro.ofi60s,
      ofi300s: micro.ofi300s,
      tradeFlowImbalance30s: micro.tradeFlowImbalance30s,
      tradeFlowImbalance60s: micro.tradeFlowImbalance60s,
      micropriceEdge: micro.micropriceEdge,
      depthSkew: micro.depthSkew,
      volumeSurge: micro.volumeSurge,
      vwapDeviation: micro.vwapDeviation,
      spreadBps: micro.spreadBps,
      spreadRegime: micro.spreadRegime,
    } : {}),
  };
}
