#!/usr/bin/env tsx
/**
 * BTC 5-Minute Trading Daemon
 *
 * Discovers Polymarket BTC up/down markets every 5 minutes, runs prediction
 * strategies, and executes trades through a configurable adapter.
 *
 * Usage:
 *   npx tsx src/btc-trader/index.ts               # run daemon
 *   npx tsx src/btc-trader/index.ts --backtest 7   # backtest 7 days
 *   npx tsx src/btc-trader/index.ts --status        # show status
 */
import * as fs from 'fs';
import * as path from 'path';
import { btcConfig } from './config';
import { logger } from './clock/logger';
import { marketClock } from './clock/market-clock';
import { BinancePriceFeed } from './data/binance-ws';
import { fetchOrderbook } from './data/clob-client';
import { getSentiment } from './data/news-feed';
import { checkGeoblock } from './data/gamma-client';
import { buildFeatureVector, FeatureBuildContext } from './features/feature-vector';
import { EnsembleStrategy } from './strategies/ensemble';
import { EnsembleV2Strategy } from './strategies/ensemble-v2';
import { Strategy } from './strategies/strategy-interface';
import { ExecutionAdapter, createOrderId } from './execution/execution-adapter';
import { DryRunAdapter } from './execution/dry-run';
import { PolymarketExecAdapter } from './execution/polymarket-exec';
import { AlpacaCryptoExecAdapter } from './execution/alpaca-crypto-exec';
import {
  readState, writeState, writeHealth, appendCycleLog,
  updateStatsAfterTrade, resetDailyStats, BtcTradingState,
} from './state/trading-state';
import { btcNotify, notifyDecision, notifyFill, notifySkip, notifyResolution, notifyDailySummary } from './notifications/notifier';
import { MarketWindow, StrategyDecision, TradeOrder, WindowCycleLog, SentimentScore } from './types';

let running = false;
let priceFeed: BinancePriceFeed;
let strategy: Strategy;
let executor: ExecutionAdapter;
let lastTradeEpoch = 0;
const evalCheckpoints = btcConfig.trading.strategy === 'v2'
  ? [75, 150, 220, 260]
  : [75, 150, 220];
let lastEvalCheckpoint: Record<number, number> = {}; // epoch -> last checkpoint index evaluated
let lastSentiment: SentimentScore | null = null;
let lastSentimentFetch = 0;

const SENTIMENT_CACHE_MS = 5 * 60 * 1000; // refresh sentiment every 5 min

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--backtest')) {
    const days = parseInt(args[args.indexOf('--backtest') + 1] || '7', 10);
    // Delegate to backtest runner
    const { collectHistoricalData } = await import('./data/historical');
    const { runAllStrategiesBacktest, generateReport } = await import('./backtest/backtest-runner');
    logger.info(`Starting backtest for ${days} days...`);
    const windows = await collectHistoricalData(days, 3);
    const results = runAllStrategiesBacktest(windows);
    console.log(generateReport(results));
    return;
  }

  if (args.includes('--status')) {
    const state = readState();
    console.log(JSON.stringify(state, null, 2));
    return;
  }

  await runDaemon();
}

const PID_FILE = path.join(process.cwd(), 'state', 'btc-trader.pid');

function killPreviousInstance(): void {
  try {
    if (fs.existsSync(PID_FILE)) {
      const oldPid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
      if (oldPid && oldPid !== process.pid) {
        try {
          process.kill(oldPid, 0); // check if alive
          logger.info(`Killing previous daemon instance (PID ${oldPid})`);
          process.kill(oldPid, 'SIGTERM');
          // Give it a moment to die
          try { process.kill(oldPid, 0); process.kill(oldPid, 'SIGKILL'); } catch { /* already dead */ }
        } catch { /* process doesn't exist, that's fine */ }
      }
      fs.unlinkSync(PID_FILE);
    }
  } catch { /* ignore errors reading/deleting pid file */ }
}

function writePidFile(): void {
  const stateDir = path.join(process.cwd(), 'state');
  if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(PID_FILE, String(process.pid));
}

function removePidFile(): void {
  try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
}

async function runDaemon() {
  killPreviousInstance();
  writePidFile();

  logger.info('BTC 5-Minute Trading Daemon starting...');
  running = true;

  // Geo-block check
  const geo = await checkGeoblock();
  if (geo.blocked) {
    logger.warn(`Geo-blocked (${geo.country}). Polymarket execution disabled.`);
    btcNotify('SYSTEM_STATUS', `Geo-blocked from Polymarket (${geo.country}). Running in data/dry-run mode.`);
  }

  // Initialize strategy based on BTC_STRATEGY env var
  if (btcConfig.trading.strategy === 'v2') {
    strategy = new EnsembleV2Strategy();
  } else {
    strategy = new EnsembleStrategy();
  }
  logger.info(`Strategy: ${strategy.name} (${btcConfig.trading.strategy})`);

  // Initialize execution adapter
  executor = await initExecutor();
  logger.info(`Execution adapter: ${executor.name}`);

  // Initialize price feed
  priceFeed = new BinancePriceFeed();
  priceFeed.start();
  logger.info('Binance BTC/USDT price feed started');

  // Wait for first price
  await waitForPrice();

  // Initialize state
  const state = readState();
  state.executionAdapter = executor.name;
  state.dryRun = btcConfig.trading.dryRun;
  writeState(state);

  const balance = await executor.getBalance();
  btcNotify('SYSTEM_STATUS',
    `BTC 5-Min Trader started. Adapter: ${executor.name}, ` +
    `Balance: $${balance.available.toFixed(2)} ${balance.currency}, ` +
    `Strategy: ${strategy.name}, Dry-run: ${btcConfig.trading.dryRun}`
  );

  // Main loop: check every 5 seconds if we're in a new window
  const mainInterval = setInterval(async () => {
    if (!running) return;
    try {
      await tick();
    } catch (err: any) {
      logger.error(`Main loop error: ${err.message}`);
      btcNotify('ERROR', `Main loop error: ${err.message}`);
    }
  }, 5_000);

  // Check for redeemable positions every 5 minutes and notify
  const redeemInterval = setInterval(async () => {
    if (!running) return;
    if (executor instanceof PolymarketExecAdapter) {
      try {
        const count = await executor.countRedeemable();
        if (count > 0) {
          logger.info(`[POLYMARKET] ${count} position(s) ready to claim on polymarket.com`);
        }
      } catch { /* ignore */ }
    }
  }, 300_000);

  // Health heartbeat every 60 seconds
  const healthInterval = setInterval(() => {
    const state = readState();
    writeHealth({
      daemonRunning: running,
      adapter: executor.name,
      strategy: strategy.name,
      btcPrice: priceFeed.price,
      priceConnected: priceFeed.isConnected,
      lastTradeEpoch,
      todayStats: state.todayStats,
    });
  }, 60_000);

  // Daily reset at midnight UTC
  const resetInterval = setInterval(() => {
    const now = new Date();
    if (now.getUTCHours() === 0 && now.getUTCMinutes() === 0) {
      const state = readState();
      notifyDailySummary({
        ...state.todayStats,
        balance: state.balance,
      });
      resetDailyStats(state);
      writeState(state);
    }
  }, 60_000);

  // Graceful shutdown
  const shutdown = () => {
    logger.info('Shutting down BTC trader...');
    running = false;
    priceFeed.stop();
    clearInterval(mainInterval);
    clearInterval(redeemInterval);
    clearInterval(healthInterval);
    clearInterval(resetInterval);
    removePidFile();
    btcNotify('SYSTEM_STATUS', 'BTC 5-Min Trader stopped.');
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function tick() {
  const currentEpoch = marketClock.getCurrentEpoch();
  const secondsInto = marketClock.getSecondsIntoWindow();

  // Already traded this window -- nothing to do
  if (lastTradeEpoch === currentEpoch) return;

  // Find the next checkpoint we haven't evaluated yet for this epoch
  const prevCheckpointIdx = lastEvalCheckpoint[currentEpoch] ?? -1;
  let nextCheckpointIdx = -1;
  for (let i = prevCheckpointIdx + 1; i < evalCheckpoints.length; i++) {
    if (secondsInto >= evalCheckpoints[i]) {
      nextCheckpointIdx = i;
    }
  }
  if (nextCheckpointIdx < 0 || nextCheckpointIdx === prevCheckpointIdx) return;

  lastEvalCheckpoint[currentEpoch] = nextCheckpointIdx;
  // Clean up old epochs from the checkpoint map
  for (const key of Object.keys(lastEvalCheckpoint)) {
    if (Number(key) < currentEpoch - 600) delete lastEvalCheckpoint[Number(key)];
  }

  const evalLabel = nextCheckpointIdx > 0 ? ` (re-eval #${nextCheckpointIdx})` : '';
  logger.info(`Processing window epoch ${currentEpoch}, ${secondsInto}s into window${evalLabel}`);

  const state = readState();
  if (nextCheckpointIdx === 0) state.todayStats.windowsProcessed++;

  // Fetch market
  const window = await marketClock.fetchWindowByEpoch(currentEpoch);
  if (!window) {
    logger.warn(`No market found for epoch ${currentEpoch}`);
    writeState(state);
    return;
  }

  // Fetch orderbooks with timeout
  let upBook = null;
  let downBook = null;
  try {
    const bookTimeout = <T>(p: Promise<T>) => Promise.race([
      p, new Promise<null>((r) => setTimeout(() => r(null), 8_000)),
    ]);
    const [ub, db] = await Promise.all([
      window.upTokenId ? bookTimeout(fetchOrderbook(window.upTokenId)) : null,
      window.downTokenId ? bookTimeout(fetchOrderbook(window.downTokenId)) : null,
    ]);
    upBook = ub;
    downBook = db;
  } catch (err: any) {
    logger.warn(`Orderbook fetch failed: ${err.message}`);
  }

  // Refresh sentiment in background (non-blocking with timeout)
  if (Date.now() - lastSentimentFetch > SENTIMENT_CACHE_MS) {
    lastSentimentFetch = Date.now(); // mark immediately to prevent re-entry
    const sentimentTimeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 15_000));
    Promise.race([getSentiment(), sentimentTimeout])
      .then((result) => { if (result) lastSentiment = result; })
      .catch((err: any) => logger.warn(`Sentiment fetch failed: ${err.message}`));
  }

  // Build features
  const candles = priceFeed.buildCandles(60_000, 20);
  const windowDurationMs = secondsInto * 1000;
  const ctx: FeatureBuildContext = {
    btcCandles: candles,
    windowEpoch: currentEpoch,
    currentTimeMs: Date.now(),
    upBook,
    downBook,
    sentiment: lastSentiment,
    priceFeedReturn5m: priceFeed.getReturn(windowDurationMs),
    priceFeedReturn1m: priceFeed.getReturn(60_000),
  };
  const features = buildFeatureVector(ctx);

  logger.info(
    `Features: btcPrice=$${features.btcPrice.toFixed(2)}, ret1m=${(features.btcReturn1m * 100).toFixed(4)}%, ` +
    `ret5m=${(features.btcReturn5m * 100).toFixed(4)}%, vol5m=${(features.btcVolatility5m * 10000).toFixed(1)}bps, ` +
    `mom=${features.btcMomentum.toFixed(3)}, probUp=${features.impliedProbUp.toFixed(3)}, ` +
    `probDown=${features.impliedProbDown.toFixed(3)}, candles=${candles.length}, ` +
    `sentiment=${features.sentimentScore.toFixed(2)}, secInWindow=${features.secondsIntoWindow}`
  );

  // Run each sub-strategy individually for logging
  let subDecisions: StrategyDecision[] = [];
  if (strategy.name === 'ensemble') {
    const ensemble = strategy as any;
    if (ensemble.getSubStrategies) {
      for (const sub of ensemble.getSubStrategies()) {
        const subDec = sub.decide(features, window);
        subDecisions.push(subDec);
        logger.info(
          `  [${sub.name}] ${subDec.direction} conf=${subDec.confidence.toFixed(3)} -- ${subDec.reasoning}`
        );
      }
    }
  }

  // Run strategy
  const decision = strategy.decide(features, window);

  logger.info(
    `Decision: ${decision.direction} (${decision.strategy}, confidence: ${decision.confidence.toFixed(3)})` +
    (decision.reasoning ? ` -- ${decision.reasoning}` : '')
  );

  // Execute if not abstaining
  let tradeResult = null;
  if (decision.direction !== 'abstain') {
    const isUp = decision.direction === 'up';
    const tokenId = isUp ? window.upTokenId : window.downTokenId;
    const marketPrice = isUp ? features.impliedProbUp : features.impliedProbDown;

    const bal = await executor.getBalance();

    // V2 proportional sizing: bet fraction of bankroll based on Kelly
    // V1 fixed sizing: use budgetPerTrade
    let tradeBudget: number;
    if (btcConfig.trading.strategy === 'v2' && decision.suggestedSize !== undefined) {
      const kelly = Math.min(Math.max(decision.suggestedSize, 0), 1);
      const { minBetFraction, maxBetFraction, minBalance } = btcConfig.trading;
      const fraction = minBetFraction + kelly * (maxBetFraction - minBetFraction);
      tradeBudget = bal.available * fraction;

      if (bal.available < minBalance) {
        logger.warn(`Balance $${bal.available.toFixed(2)} below minimum $${minBalance}. Claim wins at polymarket.com`);
        btcNotify('ERROR', `Balance too low: $${bal.available.toFixed(2)} < $${minBalance} min. Claim at polymarket.com`);
        writeState(state);
        return;
      }
      logger.info(`V2 sizing: Kelly=${kelly.toFixed(3)}, fraction=${(fraction * 100).toFixed(1)}%, budget=$${tradeBudget.toFixed(2)} of $${bal.available.toFixed(2)}`);
    } else {
      tradeBudget = btcConfig.trading.budgetPerTrade;
    }

    const estCost = Math.max(5, Math.ceil(1.05 / marketPrice)) * marketPrice;
    if (bal.available < estCost) {
      logger.warn(`Insufficient balance: $${bal.available.toFixed(2)} < $${estCost.toFixed(2)} needed. Claim positions on polymarket.com`);
      btcNotify('ERROR', `Skipped trade: only $${bal.available.toFixed(2)} available, need ~$${estCost.toFixed(2)}. Claim wins at polymarket.com`);
      writeState(state);
      return;
    }

    const orderPrice = Math.min(0.99, marketPrice + 0.005);
    const orderSize = tradeBudget / marketPrice;

    const order: TradeOrder = {
      id: createOrderId(decision.strategy, window.slug),
      windowSlug: window.slug,
      direction: decision.direction,
      tokenId,
      side: 'buy',
      price: orderPrice,
      size: orderSize,
      timestamp: Date.now(),
      strategy: decision.strategy,
    };

    notifyDecision(decision, features, orderPrice, orderSize, subDecisions.length > 0 ? subDecisions : undefined, bal.available);
    tradeResult = await executor.placeOrder(order);
    notifyFill(tradeResult);

    lastTradeEpoch = currentEpoch;

    if (tradeResult.filled) {
      state.currentWindow = {
        slug: window.slug,
        epochStart: window.epochStart,
        epochEnd: window.epochEnd,
        direction: decision.direction,
        entryPrice: tradeResult.fillPrice,
        size: tradeResult.fillSize,
        strategy: decision.strategy,
        orderId: order.id,
      };
    }
  } else if (nextCheckpointIdx === 0) {
    notifySkip(features, decision.reasoning || 'No strategy triggered', subDecisions.length > 0 ? subDecisions : undefined);
  }

  // Log cycle
  const cycleLog: WindowCycleLog = {
    windowSlug: window.slug,
    epochStart: window.epochStart,
    epochEnd: window.epochEnd,
    btcPriceAtStart: priceFeed.price,
    decisions: [decision],
    trades: tradeResult ? [tradeResult] : [],
    features: {
      btcPrice: features.btcPrice,
      btcReturn1m: features.btcReturn1m,
      btcReturn5m: features.btcReturn5m,
      impliedProbUp: features.impliedProbUp,
      impliedProbDown: features.impliedProbDown,
      sentimentScore: features.sentimentScore,
    },
    timestamp: new Date().toISOString(),
  };
  appendCycleLog(cycleLog);

  writeState(state);

  // Schedule resolution check (after window ends)
  const windowEndMs = window.epochEnd * 1000;
  const delayToEnd = windowEndMs - Date.now() + 10_000; // 10s buffer after window end
  if (delayToEnd > 0 && tradeResult?.filled) {
    setTimeout(async () => {
      await resolveWindow(window, state);
    }, delayToEnd);
  }
}

async function resolveWindow(window: MarketWindow, state: BtcTradingState) {
  try {
    const resolved = await marketClock.fetchWindowByEpoch(window.epochStart);
    if (!resolved || !resolved.resolved || !resolved.outcome) {
      logger.warn(`Window ${window.slug} not yet resolved, will check again`);
      setTimeout(() => resolveWindow(window, state), 15_000);
      return;
    }

    logger.info(`Window ${window.slug} resolved: ${resolved.outcome}`);

    const currentState = readState();
    const cw = currentState.currentWindow;
    const direction = (cw?.direction as 'up' | 'down') || 'up';
    const entryPrice = cw?.entryPrice || 0;
    const size = cw?.size || 0;

    if (executor instanceof DryRunAdapter) {
      const pnl = (executor as DryRunAdapter).resolveWindow(resolved.outcome);
      currentState.todayStats.totalPnl += pnl;
      if (pnl > 0) currentState.todayStats.wins++;
      else currentState.todayStats.losses++;
      currentState.currentWindow = undefined;
      writeState(currentState);

      notifyResolution({
        direction,
        entryPrice,
        size,
        outcome: resolved.outcome,
        pnl,
        balance: (executor as DryRunAdapter).getStats().balance,
        todayWins: currentState.todayStats.wins,
        todayLosses: currentState.todayStats.losses,
        todayPnl: currentState.todayStats.totalPnl,
      });
    } else {
      const won = direction === resolved.outcome;
      const payout = won ? size * 1.0 : 0;
      const cost = entryPrice * size;
      const pnl = payout - cost;
      currentState.todayStats.totalPnl += pnl;
      if (pnl > 0) currentState.todayStats.wins++;
      else currentState.todayStats.losses++;
      currentState.currentWindow = undefined;
      writeState(currentState);

      const bal = await executor.getBalance();
      notifyResolution({
        direction,
        entryPrice,
        size,
        outcome: resolved.outcome,
        pnl,
        balance: bal.available,
        todayWins: currentState.todayStats.wins,
        todayLosses: currentState.todayStats.losses,
        todayPnl: currentState.todayStats.totalPnl,
      });
    }
  } catch (err: any) {
    logger.error(`Resolution check failed: ${err.message}`);
  }
}

async function initExecutor(): Promise<ExecutionAdapter> {
  const adapterType = btcConfig.trading.executionAdapter;

  if (adapterType === 'polymarket') {
    const adapter = new PolymarketExecAdapter();
    if (await adapter.isAvailable()) return adapter;
    logger.warn('Polymarket adapter unavailable, falling back to dry-run');
  }

  if (adapterType === 'alpaca') {
    const adapter = new AlpacaCryptoExecAdapter();
    if (await adapter.isAvailable()) return adapter;
    logger.warn('Alpaca adapter unavailable, falling back to dry-run');
  }

  return new DryRunAdapter(btcConfig.trading.budgetPerTrade * 20);
}

async function waitForPrice(): Promise<void> {
  logger.info('Waiting for first BTC price...');
  const maxWait = 30_000;
  const start = Date.now();
  while (priceFeed.price === 0 && Date.now() - start < maxWait) {
    await new Promise((r) => setTimeout(r, 500));
  }
  if (priceFeed.price > 0) {
    logger.info(`BTC price: $${priceFeed.price.toFixed(2)}`);
  } else {
    logger.warn('No BTC price after 30s, continuing with stale data');
  }
}

main().catch((err) => {
  logger.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
