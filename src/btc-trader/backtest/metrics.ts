import { BacktestMetrics, TradeResult, StrategyDecision } from '../types';

export function computeMetrics(
  strategyName: string,
  decisions: StrategyDecision[],
  trades: TradeResult[],
  totalWindows: number
): BacktestMetrics {
  const traded = decisions.filter((d) => d.direction !== 'abstain');
  const abstained = decisions.filter((d) => d.direction === 'abstain');

  const correct = trades.filter((t) => t.pnl > 0).length;
  const incorrect = trades.filter((t) => t.pnl <= 0).length;
  const winRate = trades.length > 0 ? correct / trades.length : 0;

  const pnls = trades.map((t) => t.pnl);
  const totalPnl = pnls.reduce((a, b) => a + b, 0);
  const grossWins = pnls.filter((p) => p > 0).reduce((a, b) => a + b, 0);
  const grossLosses = Math.abs(pnls.filter((p) => p < 0).reduce((a, b) => a + b, 0));
  const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? Infinity : 0;

  const maxDrawdown = computeMaxDrawdown(pnls);
  const sharpeRatio = computeSharpe(pnls);
  const brierScore = computeBrierScore(decisions, trades);

  const avgConfidence = traded.length > 0
    ? traded.reduce((s, d) => s + d.confidence, 0) / traded.length
    : 0;
  const avgPnlPerTrade = trades.length > 0 ? totalPnl / trades.length : 0;

  return {
    strategyName,
    totalWindows,
    windowsTraded: traded.length,
    windowsAbstained: abstained.length,
    correctPredictions: correct,
    incorrectPredictions: incorrect,
    winRate,
    totalPnl,
    grossWins,
    grossLosses,
    profitFactor,
    maxDrawdown,
    sharpeRatio,
    brierScore,
    avgConfidence,
    avgPnlPerTrade,
  };
}

function computeMaxDrawdown(pnls: number[]): number {
  let peak = 0;
  let cumulative = 0;
  let maxDD = 0;

  for (const pnl of pnls) {
    cumulative += pnl;
    if (cumulative > peak) peak = cumulative;
    const dd = peak - cumulative;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}

function computeSharpe(pnls: number[], riskFreeRate = 0): number {
  if (pnls.length < 2) return 0;
  const mean = pnls.reduce((a, b) => a + b, 0) / pnls.length;
  const variance = pnls.reduce((s, p) => s + (p - mean) ** 2, 0) / pnls.length;
  const stddev = Math.sqrt(variance);
  if (stddev < 0.001) return mean > 0 ? 99.99 : 0; // cap to avoid overflow
  const periodsPerYear = 288 * 365;
  return Math.min(999.99, ((mean - riskFreeRate) / stddev) * Math.sqrt(periodsPerYear));
}

function computeBrierScore(
  decisions: StrategyDecision[],
  trades: TradeResult[]
): number {
  if (trades.length === 0) return 1;

  let totalBrier = 0;
  let count = 0;

  for (let i = 0; i < trades.length; i++) {
    const trade = trades[i];
    const decision = decisions.find(
      (d) => d.strategy === trade.order.strategy && d.direction !== 'abstain'
    );
    if (!decision || !trade.resolvedOutcome) continue;

    const predicted = decision.confidence;
    const actual = trade.resolvedOutcome === decision.direction ? 1 : 0;
    totalBrier += (predicted - actual) ** 2;
    count++;
  }

  return count > 0 ? totalBrier / count : 1;
}

export function formatMetricsTable(allMetrics: BacktestMetrics[]): string {
  const header = [
    'Strategy'.padEnd(22),
    'Traded'.padStart(7),
    'Win%'.padStart(7),
    'P&L'.padStart(10),
    'Avg P&L'.padStart(10),
    'MaxDD'.padStart(10),
    'Sharpe'.padStart(8),
    'Brier'.padStart(7),
    'PF'.padStart(6),
  ].join(' | ');

  const sep = '-'.repeat(header.length);

  const rows = allMetrics.map((m) => [
    m.strategyName.padEnd(22),
    String(m.windowsTraded).padStart(7),
    `${(m.winRate * 100).toFixed(1)}%`.padStart(7),
    `$${m.totalPnl.toFixed(2)}`.padStart(10),
    `$${m.avgPnlPerTrade.toFixed(2)}`.padStart(10),
    `$${m.maxDrawdown.toFixed(2)}`.padStart(10),
    m.sharpeRatio.toFixed(2).padStart(8),
    m.brierScore.toFixed(3).padStart(7),
    m.profitFactor === Infinity ? '   Inf' : m.profitFactor.toFixed(2).padStart(6),
  ].join(' | '));

  return [sep, header, sep, ...rows, sep].join('\n');
}
