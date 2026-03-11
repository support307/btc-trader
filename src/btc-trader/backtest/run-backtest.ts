#!/usr/bin/env tsx
/**
 * BTC 5-Minute Strategy Backtester
 *
 * Collects historical data from Polymarket + Binance, runs all strategies,
 * and generates a comparison report.
 *
 * Usage: npx tsx src/btc-trader/backtest/run-backtest.ts [days]
 */
import { collectHistoricalData } from '../data/historical';
import { runAllStrategiesBacktest, generateReport } from './backtest-runner';
import { logger } from '../clock/logger';
import * as fs from 'fs';
import * as path from 'path';

async function main() {
  const days = parseInt(process.argv[2] || '7', 10);
  logger.info(`Starting BTC 5-minute strategy backtest for ${days} days`);

  const outputDir = path.join(process.cwd(), 'backtest-results');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  logger.info('Phase 1: Collecting historical data...');
  const windows = await collectHistoricalData(days, 3);

  const resolved = windows.filter((w) => w.market?.resolved);
  const withBtcData = windows.filter((w) => w.btcCandles.length > 0);
  logger.info(
    `Data collected: ${windows.length} total windows, ` +
    `${resolved.length} resolved, ${withBtcData.length} with BTC data`
  );

  if (resolved.length < 10) {
    logger.error('Insufficient resolved windows for meaningful backtest. Need at least 10.');
    logger.info('This may be due to Polymarket API rate limits or data availability.');
    logger.info('Try running with fewer days or checking API access.');

    // Even with limited data, generate a sample report
    if (resolved.length > 0) {
      logger.info(`Running backtest with ${resolved.length} available windows...`);
    } else {
      logger.info('Running with simulated data to validate strategy logic...');
      const simWindows = generateSimulatedWindows(days);
      const results = runAllStrategiesBacktest(simWindows);
      const report = generateReport(results);
      console.log('\n' + report);
      saveResults(outputDir, results, report, 'simulated');
      return;
    }
  }

  logger.info('Phase 2: Running strategy backtests...');
  const results = runAllStrategiesBacktest(windows);

  logger.info('Phase 3: Generating report...');
  const report = generateReport(results);
  console.log('\n' + report);

  saveResults(outputDir, results, report, 'historical');

  // Summary recommendation
  const best = results.reduce((a, b) =>
    a.metrics.totalPnl > b.metrics.totalPnl ? a : b
  );
  const bestSharpe = results.reduce((a, b) =>
    a.metrics.sharpeRatio > b.metrics.sharpeRatio ? a : b
  );

  console.log('\n=== RECOMMENDATION ===');
  console.log(`Best by P&L:    ${best.strategyName} ($${best.metrics.totalPnl.toFixed(2)})`);
  console.log(`Best by Sharpe: ${bestSharpe.strategyName} (${bestSharpe.metrics.sharpeRatio.toFixed(2)})`);
  console.log('\nFor production deployment, consider:');
  console.log('1. Start with the ensemble strategy in dry-run mode');
  console.log('2. Validate live performance matches backtest');
  console.log('3. Graduate to tiny real execution ($10-50/trade)');
}

function saveResults(
  dir: string,
  results: any[],
  report: string,
  dataType: string
) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');

  fs.writeFileSync(
    path.join(dir, `report-${dataType}-${ts}.txt`),
    report
  );

  fs.writeFileSync(
    path.join(dir, `results-${dataType}-${ts}.json`),
    JSON.stringify(results.map((r) => ({
      strategyName: r.strategyName,
      metrics: r.metrics,
      tradeCount: r.trades.length,
      sampleTrades: r.trades.slice(0, 10),
    })), null, 2)
  );

  logger.info(`Results saved to ${dir}/`);
}

function generateSimulatedWindows(days: number) {
  const { HistoricalWindow } = require('../data/historical') as any;
  const now = Math.floor(Date.now() / 1000);
  const startTs = now - days * 24 * 3600;
  const windows: any[] = [];

  // Generate synthetic BTC price path with realistic parameters
  let btcPrice = 82000;
  const epochStep = 300;
  const volatility = 0.0002; // per minute

  for (let epoch = Math.ceil(startTs / epochStep) * epochStep; epoch < now; epoch += epochStep) {
    const candles = [];
    let price = btcPrice;
    const windowStartMs = epoch * 1000;

    for (let m = -15; m <= 5; m++) {
      const change = (Math.random() - 0.5) * 2 * volatility * price;
      price += change;
      candles.push({
        timestamp: windowStartMs + m * 60_000,
        open: price - change / 2,
        high: price + Math.abs(change),
        low: price - Math.abs(change),
        close: price,
        volume: 10 + Math.random() * 50,
      });
    }

    const startPrice = candles.find((c: any) => c.timestamp >= windowStartMs)?.open || price;
    const endPrice = candles[candles.length - 1].close;
    const outcome = endPrice >= startPrice ? 'up' : 'down';
    btcPrice = price;

    const upProb = 0.5 + (endPrice - startPrice) / startPrice * 100;
    const clampedUpProb = Math.max(0.05, Math.min(0.95, upProb));

    windows.push({
      epoch,
      market: {
        slug: `btc-updown-5m-${epoch}`,
        epochStart: epoch,
        epochEnd: epoch + 300,
        conditionId: `sim-${epoch}`,
        upTokenId: `sim-up-${epoch}`,
        downTokenId: `sim-down-${epoch}`,
        resolved: true,
        outcome,
      },
      btcCandles: candles,
      upPriceHistory: [
        { t: epoch, p: 0.50 },
        { t: epoch + 60, p: 0.50 + (endPrice - startPrice) / startPrice * 50 },
        { t: epoch + 150, p: clampedUpProb },
        { t: epoch + 250, p: outcome === 'up' ? 0.85 : 0.15 },
      ],
      downPriceHistory: [
        { t: epoch, p: 0.50 },
        { t: epoch + 60, p: 0.50 - (endPrice - startPrice) / startPrice * 50 },
        { t: epoch + 150, p: 1 - clampedUpProb },
        { t: epoch + 250, p: outcome === 'down' ? 0.85 : 0.15 },
      ],
    });
  }

  return windows;
}

main().catch((err) => {
  logger.error(`Backtest failed: ${err.message}`);
  console.error(err);
  process.exit(1);
});
