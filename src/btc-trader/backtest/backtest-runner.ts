import { logger } from '../clock/logger';
import { Strategy } from '../strategies/strategy-interface';
import { EnsembleStrategy } from '../strategies/ensemble';
import { CloseSnipeStrategy } from '../strategies/close-snipe';
import { MomentumOrderbookStrategy } from '../strategies/momentum-orderbook';
import { ArbitrageStrategy } from '../strategies/arbitrage';
import { SentimentGatedStrategy } from '../strategies/sentiment-gated';
import { buildFeatureVector, FeatureBuildContext } from '../features/feature-vector';
import { HistoricalWindow } from '../data/historical';
import {
  StrategyDecision, TradeResult, TradeOrder, BacktestMetrics,
  FeatureVector, MarketWindow, OHLCV, OrderbookSnapshot,
} from '../types';
import { computeMetrics, formatMetricsTable } from './metrics';
import { takerFee } from '../features/fees';
import { btcConfig } from '../config';

interface BacktestConfig {
  budgetPerTrade: number;
  simulateEntryAtSecond: number;    // when the strategy "decides" within the window
  slippageBps: number;              // basis points of slippage to add
}

const DEFAULT_CONFIG: BacktestConfig = {
  budgetPerTrade: 50,
  simulateEntryAtSecond: 150,       // middle of window for momentum, overridden per strategy
  slippageBps: 10,
};

export interface BacktestResult {
  strategyName: string;
  metrics: BacktestMetrics;
  decisions: StrategyDecision[];
  trades: TradeResult[];
}

export function runBacktest(
  windows: HistoricalWindow[],
  strategy: Strategy,
  config: Partial<BacktestConfig> = {}
): BacktestResult {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const decisions: StrategyDecision[] = [];
  const trades: TradeResult[] = [];
  let tradeCounter = 0;

  // Determine entry timing per strategy
  const entrySecond = getStrategyEntrySecond(strategy.name, cfg.simulateEntryAtSecond);

  for (const win of windows) {
    if (!win.market) continue;
    if (!win.market.resolved || !win.market.outcome) continue;

    const btcCandles = win.btcCandles;
    if (btcCandles.length === 0) continue;

    const windowStartMs = win.epoch * 1000;
    const decisionTimeMs = windowStartMs + entrySecond * 1000;

    // Build candles available at decision time
    const availableCandles = btcCandles.filter((c) => c.timestamp <= decisionTimeMs);
    if (availableCandles.length < 2) continue;

    // Simulate orderbook from price history (approximate)
    const upBook = simulateOrderbook(win.upPriceHistory, win.epoch, entrySecond);
    const downBook = simulateOrderbook(win.downPriceHistory, win.epoch, entrySecond);

    // Simulate a mild sentiment signal based on recent BTC price movement
    const recentReturn = availableCandles.length >= 2
      ? (availableCandles[availableCandles.length - 1].close - availableCandles[0].close) / availableCandles[0].close
      : 0;
    const simulatedSentiment = {
      timestamp: decisionTimeMs,
      score: Math.max(-0.8, Math.min(0.8, recentReturn * 500)),
      eventRisk: 0.1 + Math.random() * 0.3,
      headlines: ['Simulated backtest headline'],
      source: 'backtest' as const,
    };

    const ctx: FeatureBuildContext = {
      btcCandles: availableCandles,
      windowEpoch: win.epoch,
      currentTimeMs: decisionTimeMs,
      upBook,
      downBook,
      sentiment: simulatedSentiment,
    };

    const features = buildFeatureVector(ctx);
    const decision = strategy.decide(features, win.market);
    decisions.push(decision);

    if (decision.direction === 'abstain') continue;

    // Simulate trade
    const trade = simulateTrade(
      decision, win.market, features, cfg, ++tradeCounter
    );
    trades.push(trade);
  }

  const totalWindows = windows.filter((w) => w.market?.resolved).length;
  const metrics = computeMetrics(strategy.name, decisions, trades, totalWindows);

  return { strategyName: strategy.name, metrics, decisions, trades };
}

function getStrategyEntrySecond(name: string, defaultSec: number): number {
  switch (name) {
    case 'close-snipe': return 250; // last ~50 seconds
    case 'momentum-orderbook': return 120; // 2 minutes in
    case 'arbitrage': return 60; // scan early
    case 'sentiment-gated': return 90;
    case 'ensemble': return 250; // late like close-snipe for strongest signal
    default: return defaultSec;
  }
}

function simulateOrderbook(
  priceHistory: Array<{ t: number; p: number }>,
  windowEpoch: number,
  entrySecond: number
): OrderbookSnapshot | null {
  if (priceHistory.length === 0) return null;

  const targetTime = windowEpoch + entrySecond;
  let closest = priceHistory[0];
  let minDist = Math.abs(closest.t - targetTime);

  for (const h of priceHistory) {
    const dist = Math.abs(h.t - targetTime);
    if (dist < minDist) {
      minDist = dist;
      closest = h;
    }
  }

  const mid = Math.max(0.02, Math.min(0.98, closest.p));
  const halfSpread = 0.005;

  // Simulate directional pressure through bid/ask depth asymmetry
  const bullishBias = mid > 0.5;
  const bidMult = bullishBias ? 1.5 : 0.7;
  const askMult = bullishBias ? 0.7 : 1.5;

  return {
    timestamp: closest.t * 1000,
    tokenId: '',
    bids: [
      { price: Math.max(0.001, mid - halfSpread), size: 100 * bidMult },
      { price: Math.max(0.001, mid - halfSpread * 2), size: 200 * bidMult },
      { price: Math.max(0.001, mid - halfSpread * 3), size: 300 * bidMult },
    ],
    asks: [
      { price: Math.min(0.999, mid + halfSpread), size: 100 * askMult },
      { price: Math.min(0.999, mid + halfSpread * 2), size: 200 * askMult },
      { price: Math.min(0.999, mid + halfSpread * 3), size: 300 * askMult },
    ],
  };
}

function simulateTrade(
  decision: StrategyDecision,
  window: MarketWindow,
  features: FeatureVector,
  config: BacktestConfig,
  tradeId: number
): TradeResult {
  const isUp = decision.direction === 'up';
  const tokenId = isUp ? window.upTokenId : window.downTokenId;
  const marketPrice = isUp ? features.impliedProbUp : features.impliedProbDown;

  // Entry price with slippage
  const slippage = marketPrice * (config.slippageBps / 10000);
  const entryPrice = Math.min(0.999, marketPrice + slippage);

  const size = Math.min(
    config.budgetPerTrade / entryPrice,
    decision.suggestedSize || config.budgetPerTrade / entryPrice
  );

  const fee = takerFee(entryPrice, size);
  const costBasis = entryPrice * size + fee;

  const won = decision.direction === window.outcome;
  const payout = won ? size * 1.0 : 0;
  const pnl = payout - costBasis;

  const order: TradeOrder = {
    id: `bt-${tradeId}`,
    windowSlug: window.slug,
    direction: decision.direction as 'up' | 'down',
    tokenId,
    side: 'buy',
    price: entryPrice,
    size,
    timestamp: features.timestamp,
    strategy: decision.strategy,
  };

  return {
    order,
    filled: true,
    fillPrice: entryPrice,
    fillSize: size,
    fee,
    pnl,
    resolvedOutcome: window.outcome,
  };
}

export function runAllStrategiesBacktest(
  windows: HistoricalWindow[]
): BacktestResult[] {
  const strategies: Strategy[] = [
    new CloseSnipeStrategy(),
    new MomentumOrderbookStrategy(),
    new ArbitrageStrategy(),
    new SentimentGatedStrategy(),
    new EnsembleStrategy(),
  ];

  const results: BacktestResult[] = [];

  for (const strategy of strategies) {
    logger.info(`Running backtest for strategy: ${strategy.name}`);
    const result = runBacktest(windows, strategy);
    results.push(result);
    logger.info(
      `  ${strategy.name}: ${result.metrics.windowsTraded} trades, ` +
      `${(result.metrics.winRate * 100).toFixed(1)}% win rate, ` +
      `P&L $${result.metrics.totalPnl.toFixed(2)}`
    );
  }

  return results;
}

export function generateReport(results: BacktestResult[]): string {
  const metrics = results.map((r) => r.metrics);
  const table = formatMetricsTable(metrics);

  const best = metrics.reduce((a, b) =>
    (a.totalPnl > b.totalPnl ? a : b), metrics[0]);

  const bestSharpe = metrics.reduce((a, b) =>
    (a.sharpeRatio > b.sharpeRatio ? a : b), metrics[0]);

  const lines: string[] = [
    '═══════════════════════════════════════════════════════════════════',
    '  BTC 5-MINUTE STRATEGY BACKTEST REPORT',
    '═══════════════════════════════════════════════════════════════════',
    '',
    table,
    '',
    `Best P&L:    ${best.strategyName} ($${best.totalPnl.toFixed(2)})`,
    `Best Sharpe: ${bestSharpe.strategyName} (${bestSharpe.sharpeRatio.toFixed(2)})`,
    '',
    'Per-strategy details:',
  ];

  for (const r of results) {
    const m = r.metrics;
    lines.push(`\n--- ${m.strategyName} ---`);
    lines.push(`  Windows: ${m.totalWindows} total, ${m.windowsTraded} traded, ${m.windowsAbstained} abstained`);
    lines.push(`  Correct: ${m.correctPredictions}, Incorrect: ${m.incorrectPredictions}`);
    lines.push(`  Win Rate: ${(m.winRate * 100).toFixed(1)}%`);
    lines.push(`  Total P&L: $${m.totalPnl.toFixed(2)} (avg $${m.avgPnlPerTrade.toFixed(2)}/trade)`);
    lines.push(`  Max Drawdown: $${m.maxDrawdown.toFixed(2)}`);
    lines.push(`  Sharpe: ${m.sharpeRatio.toFixed(2)}, Brier: ${m.brierScore.toFixed(3)}, PF: ${m.profitFactor === Infinity ? 'Inf' : m.profitFactor.toFixed(2)}`);
  }

  lines.push('');
  lines.push('═══════════════════════════════════════════════════════════════════');

  return lines.join('\n');
}
