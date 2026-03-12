export interface MarketWindow {
  slug: string;
  epochStart: number;
  epochEnd: number;
  conditionId: string;
  upTokenId: string;
  downTokenId: string;
  priceToBeat?: number;
  resolved?: boolean;
  outcome?: 'up' | 'down';
}

export interface PriceTick {
  timestamp: number;
  price: number;
  volume?: number;
}

export interface OHLCV {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface OrderbookLevel {
  price: number;
  size: number;
}

export interface OrderbookSnapshot {
  timestamp: number;
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
  tokenId: string;
}

export interface SentimentScore {
  timestamp: number;
  score: number;       // -1 (very bearish) to +1 (very bullish)
  eventRisk: number;   // 0 (calm) to 1 (high risk event)
  headlines: string[];
  source: string;
}

export interface FeatureVector {
  timestamp: number;
  windowEpoch: number;
  secondsIntoWindow: number;

  btcPrice: number;
  btcReturn1m: number;
  btcReturn5m: number;
  btcReturn15m: number;
  windowReturn: number;
  btcVolatility1m: number;
  btcVolatility5m: number;
  btcMomentum: number;

  bookBidAskSpreadUp: number;
  bookBidAskSpreadDown: number;
  bookDepthImbalanceUp: number;
  bookDepthImbalanceDown: number;
  impliedProbUp: number;
  impliedProbDown: number;

  sentimentScore: number;
  eventRisk: number;

  hourOfDay: number;
  dayOfWeek: number;
  isWeekend: boolean;

  // V4 microstructure fields (optional -- only populated when Binance L2 feed is active)
  ofi30s?: number;
  ofi60s?: number;
  ofi300s?: number;
  tradeFlowImbalance30s?: number;
  tradeFlowImbalance60s?: number;
  micropriceEdge?: number;
  depthSkew?: number;
  volumeSurge?: number;
  vwapDeviation?: number;
  spreadBps?: number;
  spreadRegime?: 'tight' | 'normal' | 'wide';
}

export type Direction = 'up' | 'down' | 'abstain';

export interface StrategyDecision {
  direction: Direction;
  confidence: number;    // 0–1
  strategy: string;
  reasoning: string;
  suggestedSize?: number;
  features?: Partial<FeatureVector>;
}

export interface TradeOrder {
  id: string;
  windowSlug: string;
  direction: Direction;
  tokenId: string;
  side: 'buy' | 'sell';
  price: number;
  size: number;
  timestamp: number;
  strategy: string;
}

export interface TradeResult {
  order: TradeOrder;
  filled: boolean;
  fillPrice: number;
  fillSize: number;
  fee: number;
  pnl: number;
  resolvedOutcome?: 'up' | 'down';
}

export interface WindowCycleLog {
  windowSlug: string;
  epochStart: number;
  epochEnd: number;
  btcPriceAtStart: number;
  btcPriceAtEnd?: number;
  decisions: StrategyDecision[];
  trades: TradeResult[];
  features: Partial<FeatureVector>;
  resolvedOutcome?: 'up' | 'down';
  timestamp: string;
}

export interface BacktestMetrics {
  strategyName: string;
  totalWindows: number;
  windowsTraded: number;
  windowsAbstained: number;
  correctPredictions: number;
  incorrectPredictions: number;
  winRate: number;
  totalPnl: number;
  grossWins: number;
  grossLosses: number;
  profitFactor: number;
  maxDrawdown: number;
  sharpeRatio: number;
  brierScore: number;
  avgConfidence: number;
  avgPnlPerTrade: number;
}

export interface PolymarketFee {
  takerFeeRate(price: number): number;
  makerRebateRate(price: number): number;
}
