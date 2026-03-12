import { BinanceOrderBookFeed } from '../data/binance-orderbook-ws';
import { BinancePriceFeed } from '../data/binance-ws';

export type SpreadRegime = 'tight' | 'normal' | 'wide';

export interface MicrostructureState {
  ofi30s: number;
  ofi60s: number;
  ofi300s: number;

  tradeFlowImbalance30s: number;
  tradeFlowImbalance60s: number;

  micropriceEdge: number;

  depthSkew: number;

  volumeSurge: number;

  vwapDeviation: number;

  spreadBps: number;
  spreadRegime: SpreadRegime;

  bookSynced: boolean;
}

const SPREAD_TIGHT_BPS = 1.0;
const SPREAD_WIDE_BPS = 3.0;

function classifySpreadRegime(spreadBps: number): SpreadRegime {
  if (spreadBps <= SPREAD_TIGHT_BPS) return 'tight';
  if (spreadBps >= SPREAD_WIDE_BPS) return 'wide';
  return 'normal';
}

/**
 * Computes all microstructure features from the Binance L2 order book feed
 * and the trade stream. These feed the V4 strategy's 6 signal detectors.
 */
export function computeMicrostructureFeatures(
  bookFeed: BinanceOrderBookFeed | null,
  priceFeed: BinancePriceFeed,
  windowStartMs: number,
): MicrostructureState {
  if (!bookFeed || !bookFeed.isSynced) {
    return emptyState();
  }

  const bookState = bookFeed.getBookState();

  const tfi30 = priceFeed.getTradeFlowImbalance(30_000);
  const tfi60 = priceFeed.getTradeFlowImbalance(60_000);

  const volumeSurge = priceFeed.getVolumeSurge(30_000, 300_000);

  const vwapDev = priceFeed.getVWAPDeviation(windowStartMs);

  const spreadRegime = classifySpreadRegime(bookState.spreadBps);

  return {
    ofi30s: bookState.ofi30s,
    ofi60s: bookState.ofi60s,
    ofi300s: bookState.ofi300s,
    tradeFlowImbalance30s: tfi30,
    tradeFlowImbalance60s: tfi60,
    micropriceEdge: bookState.micropriceEdge,
    depthSkew: bookState.depthSkew,
    volumeSurge,
    vwapDeviation: vwapDev,
    spreadBps: bookState.spreadBps,
    spreadRegime,
    bookSynced: bookState.synced,
  };
}

function emptyState(): MicrostructureState {
  return {
    ofi30s: 0,
    ofi60s: 0,
    ofi300s: 0,
    tradeFlowImbalance30s: 0,
    tradeFlowImbalance60s: 0,
    micropriceEdge: 0,
    depthSkew: 0,
    volumeSurge: 0,
    vwapDeviation: 0,
    spreadBps: 0,
    spreadRegime: 'normal',
    bookSynced: false,
  };
}
