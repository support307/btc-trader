import { config } from './config';
import { logger } from './utils/logger';
import { AlpacaClient } from './alpaca/client';
import { GuruTradeManager } from './trading/guru-trade-manager';
import { DiscordMonitor } from './discord/monitor';
import * as notifier from './notifications/notifier';
import { getClassificationStats, getLastClassification, resetClassificationStats } from './parser/message-classifier';
import * as fs from 'fs';
import * as path from 'path';

const alpaca = new AlpacaClient();
const tradeManager = new GuruTradeManager(alpaca);
let discordMonitor: DiscordMonitor | null = null;

// ─── Main Daemon: Discord Monitor + Guru Trade Manager ────────

// Milestone thresholds for alerts (informational only, no sell action)
const UP_MILESTONES = [50, 100, 200, 300, 500, 1000];
const DOWN_MILESTONES = [-25, -50, -75];

function getMarketZone(): 'hot' | 'cruise' | 'off' {
  const now = new Date();
  const pst = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const day = pst.getDay();
  const totalMin = pst.getHours() * 60 + pst.getMinutes();
  if (day === 0 || day === 6) return 'off';
  if (totalMin >= 385 && totalMin < 465) return 'hot';     // 6:25-7:45 AM
  if (totalMin >= 465 && totalMin < 760) return 'cruise';   // 7:45 AM-12:40 PM
  return 'off';
}

function getStatusIntervalMs(): number {
  const zone = getMarketZone();
  switch (zone) {
    case 'hot': return 5 * 60_000;    // 5 minutes
    case 'cruise': return 15 * 60_000; // 15 minutes
    case 'off': return 30 * 60_000;    // 30 minutes (minimal)
  }
}

async function sendPositionUpdate(): Promise<void> {
  try {
    const state = tradeManager.readState();
    const posKeys = Object.keys(state.positions);
    if (posKeys.length === 0) return;

    const pos = state.positions[posKeys[0]];
    let alpacaPos;
    try {
      alpacaPos = await alpaca.getPosition(pos.symbol);
    } catch { return; }
    if (!alpacaPos) return;

    const current = parseFloat(alpacaPos.current_price);
    const pctChange = (current - pos.entryPrice) / pos.entryPrice * 100;
    const pl = parseFloat(alpacaPos.unrealized_pl);
    const sign = pl >= 0 ? '+' : '';
    const entryTime = new Date(pos.entryTime);
    const minutesIn = Math.round((Date.now() - entryTime.getTime()) / 60_000);
    const lastGuru = pos.guruMessages[pos.guruMessages.length - 1] || 'none';

    notifier.notify('TRADE_UPDATE',
      `POSITION UPDATE: ${pos.ticker} $${pos.strike} ${pos.type.toUpperCase()}\n` +
      `Entry: $${pos.entryPrice} | Now: $${current.toFixed(2)} | P&L: ${sign}$${pl.toFixed(2)} (${sign}${pctChange.toFixed(1)}%)\n` +
      `Qty: ${pos.qty} contracts | Half sold: ${pos.halfSold ? 'Yes' : 'No'}\n` +
      `Time in trade: ${minutesIn} min | Guru last: "${lastGuru}"`
    );
  } catch { /* ignore errors in status updates */ }
}

async function checkMilestones(): Promise<void> {
  try {
    const state = tradeManager.readState();
    const posKeys = Object.keys(state.positions);
    if (posKeys.length === 0) return;

    const pos = state.positions[posKeys[0]];
    let alpacaPos;
    try {
      alpacaPos = await alpaca.getPosition(pos.symbol);
    } catch { return; }
    if (!alpacaPos) return;

    const current = parseFloat(alpacaPos.current_price);
    const pctChange = (current - pos.entryPrice) / pos.entryPrice * 100;
    const lastMilestone = pos.lastMilestone || 0;

    const allMilestones = [...UP_MILESTONES, ...DOWN_MILESTONES].sort((a, b) => a - b);

    let newMilestone: number | null = null;
    if (pctChange >= 0) {
      for (const m of UP_MILESTONES) {
        if (pctChange >= m && m > lastMilestone) {
          newMilestone = m;
        }
      }
    } else {
      for (const m of DOWN_MILESTONES) {
        if (pctChange <= m && m < lastMilestone) {
          newMilestone = m;
        }
      }
    }

    if (newMilestone !== null) {
      pos.lastMilestone = newMilestone;
      tradeManager.writeState(state);

      const pl = parseFloat(alpacaPos.unrealized_pl);
      const sign = newMilestone >= 0 ? '+' : '';
      const direction = newMilestone >= 0 ? 'UP' : 'DOWN';

      notifier.notify('TRADE_UPDATE',
        `MILESTONE ${direction} ${sign}${newMilestone}%: ${pos.ticker} $${pos.strike} ${pos.type.toUpperCase()}\n` +
        `Entry: $${pos.entryPrice} | Now: $${current.toFixed(2)} | P&L: ${pl >= 0 ? '+' : ''}$${pl.toFixed(2)}\n` +
        `${newMilestone >= 0 ? 'Holding for guru exit signal.' : 'Holding -- guru has not called exit. Riding it out.'}`
      );
    }
  } catch { /* ignore errors in milestone checks */ }
}

async function runDaemon() {
  logger.info('Discord Trader (Guru-Follow Mode) starting...');
  logger.info('Exit rules: Guru signal or 12:40 PM EOD only. No hard stops. No daily loss halt.');

  try {
    const account = await alpaca.getAccount();
    logger.info(`Account: $${parseFloat(account.portfolio_value).toLocaleString()} | Status: ${account.status}`);
  } catch (err: any) {
    logger.error(`Failed to connect to Alpaca: ${err.message}`);
    process.exit(1);
  }

  // Reconcile state with Alpaca on startup (recover orphaned positions)
  await tradeManager.reconcileWithAlpaca();

  const startupState = tradeManager.readState();
  const startupPositions = Object.keys(startupState.positions);
  if (startupPositions.length > 0) {
    const pos = startupState.positions[startupPositions[0]];
    notifier.notify('SIGNAL_RECEIVED',
      `DAEMON STARTED with existing position: ${pos.qty}x ${pos.ticker} $${pos.strike} ${pos.type.toUpperCase()} @ $${pos.entryPrice}. Resuming monitoring.`
    );
  }

  // Ensure logs/ dir exists for classification audit log
  const logsDir = path.join(__dirname, '..', 'logs');
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
  logger.info(`Classification audit log: ${path.join(logsDir, 'classifications.jsonl')}`);

  discordMonitor = new DiscordMonitor(tradeManager, (classified) => {
    logger.debug(`Message classified: ${classified.type} — "${classified.raw.substring(0, 60)}"`);
  });

  await discordMonitor.start();

  // Reconciliation loop: sync state with Alpaca every 60s
  const reconcileInterval = setInterval(async () => {
    try {
      await tradeManager.reconcileWithAlpaca();
    } catch (err: any) {
      logger.error(`Reconciliation error: ${err.message}`);
    }
  }, 60_000);

  // Safety check loop: 12:40 PM force close + position existence check
  const safetyInterval = setInterval(async () => {
    try {
      await tradeManager.runSafetyChecks();
    } catch (err: any) {
      logger.error(`Safety check error: ${err.message}`);
    }
  }, 10_000);

  // Milestone check every 15 seconds (fast enough to catch moves)
  const milestoneInterval = setInterval(async () => {
    await checkMilestones();
  }, 15_000);

  // Adaptive periodic WhatsApp position updates
  let lastUpdateTime = 0;
  const updateInterval = setInterval(async () => {
    const now = Date.now();
    const interval = getStatusIntervalMs();
    if (now - lastUpdateTime >= interval) {
      lastUpdateTime = now;
      await sendPositionUpdate();
    }
  }, 30_000); // Check every 30s if it's time to send

  const HEALTH_FILE_PATH = path.join(__dirname, '..', 'state', 'system-health.json');
  const daemonStartedAt = new Date().toISOString();

  function writeHealthFile(): void {
    try {
      const state = tradeManager.readState();
      const posCount = Object.keys(state.positions).length;
      const zone = getMarketZone();
      const stats = getClassificationStats();
      const last = getLastClassification();

      const health = {
        daemonStarted: daemonStartedAt,
        lastHeartbeat: new Date().toISOString(),
        zone,
        positionCount: posCount,
        lastClassification: last,
        llmEnabled: config.llm.classifierEnabled && !!config.llm.anthropicApiKey,
        todaysClassifications: stats,
      };

      const dir = path.dirname(HEALTH_FILE_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(HEALTH_FILE_PATH, JSON.stringify(health, null, 2));
    } catch (err: any) {
      logger.warn(`Failed to write health file: ${err.message}`);
    }
  }

  writeHealthFile();

  const heartbeatInterval = setInterval(() => {
    const state = tradeManager.readState();
    const posCount = Object.keys(state.positions).length;
    const zone = getMarketZone();
    logger.info(`heartbeat | zone=${zone} positions=${posCount}`);
    writeHealthFile();
  }, 60_000);

  // EOD reset at 1:00 PM PST
  const eodCheckInterval = setInterval(async () => {
    const now = new Date();
    const pst = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
    if (pst.getHours() === 13 && pst.getMinutes() >= 0 && pst.getMinutes() < 2) {
      const state = tradeManager.readState();
      if (state.closedToday.length > 0 || Object.keys(state.positions).length > 0) {
        const closedCount = state.closedToday.length;
        notifier.notify('EOD_SUMMARY', `End of day: ${closedCount} trade(s) closed. Resetting state.`);
      }
      await tradeManager.resetForNewDay();
    }
  }, 60_000);

  const shutdown = async () => {
    logger.info('Shutting down...');
    clearInterval(reconcileInterval);
    clearInterval(safetyInterval);
    clearInterval(milestoneInterval);
    clearInterval(updateInterval);
    clearInterval(heartbeatInterval);
    clearInterval(eodCheckInterval);
    if (discordMonitor) await discordMonitor.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  notifier.notify('SIGNAL_RECEIVED', 'Discord Trader (Guru-Follow Mode) online. Exits: guru signal or 12:40 PM only.');
  logger.info('Ready — monitoring Discord for guru signals');
}

// ─── CLI Commands ────────────────────────────────────────────

async function cli() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command) {
    await runDaemon();
    return;
  }

  let output: string;

  switch (command) {
    case 'portfolio': {
      const account = await alpaca.getAccount();
      const positions = await alpaca.getPositions();
      const lines = [
        'Portfolio Summary:',
        `  Equity: $${parseFloat(account.equity).toLocaleString()}`,
        `  Cash: $${parseFloat(account.cash).toLocaleString()}`,
        `  Buying Power: $${parseFloat(account.buying_power).toLocaleString()}`,
        `  Open Positions: ${positions.length}`,
      ];
      for (const pos of positions) {
        const pl = parseFloat(pos.unrealized_pl);
        const sign = pl >= 0 ? '+' : '';
        lines.push(`  ${pos.side} ${pos.qty} ${pos.symbol} @ $${parseFloat(pos.avg_entry_price).toFixed(2)} | P&L: ${sign}$${pl.toFixed(2)}`);
      }
      output = lines.join('\n');
      break;
    }

    case 'state': {
      const state = tradeManager.readState();
      output = JSON.stringify(state, null, 2);
      break;
    }

    case 'close-all': {
      const state = tradeManager.readState();
      await tradeManager.forceCloseAll(state, 'manual-close');
      output = 'All positions closed.';
      break;
    }

    case 'reset': {
      await tradeManager.resetForNewDay();
      output = 'State reset for new day.';
      break;
    }

    default:
      output = `Unknown command: ${command}\nCommands: portfolio, state, close-all, reset`;
  }

  console.log(output);
  process.exit(0);
}

cli().catch((err) => {
  logger.error(`Fatal: ${err.message}`, { stack: err.stack });
  process.exit(1);
});
