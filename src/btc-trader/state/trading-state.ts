import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../clock/logger';
import { WindowCycleLog, TradeResult, StrategyDecision } from '../types';

const STATE_DIR = path.join(process.cwd(), 'state');
const STATE_PATH = path.join(STATE_DIR, 'btc-trading-state.json');
const HEALTH_PATH = path.join(STATE_DIR, 'btc-system-health.json');
const CYCLE_LOG_PATH = path.join(process.cwd(), 'logs', 'btc-cycles.jsonl');

export interface BtcTradingState {
  currentWindow?: {
    slug: string;
    epochStart: number;
    epochEnd: number;
    direction?: 'up' | 'down' | 'abstain';
    entryPrice?: number;
    size?: number;
    strategy?: string;
    orderId?: string;
  };
  todayStats: {
    windowsProcessed: number;
    windowsTraded: number;
    totalPnl: number;
    wins: number;
    losses: number;
    lastTradeTime?: string;
  };
  cumulativeStats: {
    totalWindows: number;
    totalTrades: number;
    totalPnl: number;
    wins: number;
    losses: number;
    winRate: number;
    startDate: string;
  };
  balance: number;
  lastHeartbeat: string;
  executionAdapter: string;
  dryRun: boolean;
}

function defaultState(): BtcTradingState {
  return {
    todayStats: {
      windowsProcessed: 0,
      windowsTraded: 0,
      totalPnl: 0,
      wins: 0,
      losses: 0,
    },
    cumulativeStats: {
      totalWindows: 0,
      totalTrades: 0,
      totalPnl: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      startDate: new Date().toISOString(),
    },
    balance: 1000,
    lastHeartbeat: new Date().toISOString(),
    executionAdapter: 'dry-run',
    dryRun: true,
  };
}

export function readState(): BtcTradingState {
  try {
    if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
    if (!fs.existsSync(STATE_PATH)) {
      const state = defaultState();
      writeState(state);
      return state;
    }
    const raw = fs.readFileSync(STATE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (err: any) {
    logger.warn(`Failed to read BTC state, using defaults: ${err.message}`);
    return defaultState();
  }
}

export function writeState(state: BtcTradingState): void {
  try {
    if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  } catch (err: any) {
    logger.error(`Failed to write BTC state: ${err.message}`);
  }
}

export function writeHealth(data: Record<string, any>): void {
  try {
    if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(HEALTH_PATH, JSON.stringify({
      ...data,
      lastHeartbeat: new Date().toISOString(),
    }, null, 2));
  } catch (err: any) {
    logger.error(`Failed to write health: ${err.message}`);
  }
}

export function appendCycleLog(log: WindowCycleLog): void {
  try {
    const dir = path.dirname(CYCLE_LOG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(CYCLE_LOG_PATH, JSON.stringify(log) + '\n');
  } catch (err: any) {
    logger.error(`Failed to append cycle log: ${err.message}`);
  }
}

export function updateStatsAfterTrade(
  state: BtcTradingState,
  result: TradeResult
): void {
  state.todayStats.windowsTraded++;
  state.todayStats.totalPnl += result.pnl;
  if (result.pnl > 0) state.todayStats.wins++;
  else state.todayStats.losses++;
  state.todayStats.lastTradeTime = new Date().toISOString();

  state.cumulativeStats.totalTrades++;
  state.cumulativeStats.totalPnl += result.pnl;
  if (result.pnl > 0) state.cumulativeStats.wins = (state.cumulativeStats.wins || 0) + 1;
  else state.cumulativeStats.losses = (state.cumulativeStats.losses || 0) + 1;
  const totalCompleted = state.cumulativeStats.totalTrades;
  state.cumulativeStats.winRate = totalCompleted > 0 ? (state.cumulativeStats.wins || 0) / totalCompleted : 0;
}

export function resetDailyStats(state: BtcTradingState): void {
  state.todayStats = {
    windowsProcessed: 0,
    windowsTraded: 0,
    totalPnl: 0,
    wins: 0,
    losses: 0,
  };
}
