import { AlpacaClient, AlpacaError, Position } from '../alpaca/client';
import { TradeSignal } from '../parser/types';
import { ClassifiedMessage, MessageType } from '../parser/message-classifier';
import { config } from '../config';
import { logger } from '../utils/logger';
import * as notifier from '../notifications/notifier';
import * as fs from 'fs';
import * as path from 'path';

const STATE_PATH = path.join(__dirname, '..', '..', 'state', 'trading-state.json');

// --- State types ---

export interface GuruPosition {
  symbol: string;
  ticker: string;
  strike: number;
  type: 'call' | 'put';
  expiration: string;
  signalPrice: number;
  entryPrice: number;
  qty: number;
  entryTime: string;
  halfSold: boolean;
  guruMessages: string[];
  lastMilestone?: number;
}

export interface TradingState {
  todaysGameplan?: { tickers: string[]; direction?: string };
  positions: Record<string, GuruPosition>;
  closedToday: ClosedTrade[];
  boughtToday: boolean;
  dayTradesUsed: number;
  pendingEntry?: {
    symbol: string;
    signalPrice: number;
    ticker: string;
    strike: number;
    type: 'call' | 'put';
    expiration: string;
  };
  pendingSell?: {
    type: 'half' | 'all';
    retryCount: number;
    firstAttempt: string;
  };
}

interface ClosedTrade {
  symbol: string;
  qty: number;
  entryPrice: number;
  exitReason: string;
  exitTime: string;
  pl?: number;
}

// --- Config ---

const BUDGET_FLAT = 2000;
const FORCE_CLOSE_HOUR = 12;
const FORCE_CLOSE_MINUTE = 40;
const MAX_ENTRY_MULTIPLIER = 1.5;
const FILL_POLL_INTERVAL_MS = 500;
const FILL_TIMEOUT_MS = 10_000;
const SELL_RETRY_ATTEMPTS = 3;
const SELL_RETRY_DELAY_MS = 2000;
const MARKET_OPEN_HOUR = 6;
const MARKET_OPEN_MINUTE = 30;
const PENDING_ENTRY_DEADLINE_HOUR = 7;
const PENDING_ENTRY_DEADLINE_MINUTE = 0;

type PositionLookup =
  | { status: 'found'; position: Position }
  | { status: 'not_found' }
  | { status: 'error'; message: string };

export class GuruTradeManager {
  private alpaca: AlpacaClient;
  private processedMessages = new Set<string>();
  private consecutiveNotFound = new Map<string, number>();
  private entryInProgress = false;
  private exitInProgress = false;

  constructor(alpaca: AlpacaClient) {
    this.alpaca = alpaca;
  }

  // --- State I/O ---

  readState(): TradingState {
    try {
      const raw = fs.readFileSync(STATE_PATH, 'utf8');
      return JSON.parse(raw);
    } catch {
      const defaultState: TradingState = {
        positions: {},
        closedToday: [],
        boughtToday: false,
        dayTradesUsed: 0,
      };
      this.writeState(defaultState);
      return defaultState;
    }
  }

  writeState(state: TradingState): void {
    const dir = path.dirname(STATE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  }

  // --- Main handler: dispatch classified messages ---

  async handleMessage(classified: ClassifiedMessage): Promise<void> {
    if (this.processedMessages.has(classified.messageId)) {
      logger.debug(`Skipping duplicate message ${classified.messageId}`);
      return;
    }
    this.processedMessages.add(classified.messageId);

    const state = this.readState();

    switch (classified.type) {
      case 'GAMEPLAN':
        this.handleGameplan(state, classified);
        break;
      case 'ENTRY':
        await this.handleEntry(state, classified);
        break;
      case 'SCALE_IN':
        this.handleScaleIn(state, classified);
        break;
      case 'UPDATE':
        await this.handleUpdate(state, classified);
        break;
      case 'PARTIAL_EXIT':
        await this.handlePartialExit(state, classified);
        break;
      case 'FULL_EXIT':
        await this.handleFullExit(state, classified);
        break;
      case 'IRRELEVANT':
        break;
    }
  }

  // --- GAMEPLAN ---

  private handleGameplan(state: TradingState, msg: ClassifiedMessage): void {
    state.todaysGameplan = {
      tickers: msg.tickers || [],
      direction: msg.direction,
    };
    this.writeState(state);

    const tickers = (msg.tickers || []).map(t => `$${t}`).join(', ');
    const dir = msg.direction ? ` (${msg.direction}s)` : '';
    notifier.notify('SIGNAL_RECEIVED', `GAMEPLAN: Guru watching ${tickers}${dir} today`);
    logger.info(`Gameplan saved: ${tickers}${dir}`);
  }

  // --- ENTRY ---

  private async handleEntry(state: TradingState, msg: ClassifiedMessage): Promise<void> {
    const signal = msg.signal;
    if (!signal) {
      logger.warn('ENTRY message has no parsed signal');
      return;
    }

    if (this.entryInProgress) {
      logger.info('Entry already in progress — ignoring duplicate ENTRY signal');
      return;
    }

    if (state.boughtToday) {
      logger.info('Already bought today — no second entry allowed');
      notifier.notify('SIGNAL_RECEIVED', `ENTRY signal ignored — already bought today.`);
      return;
    }

    if (state.closedToday.length > 0) {
      logger.info('Already traded and exited today — no re-entry allowed');
      notifier.notify('SIGNAL_RECEIVED', `ENTRY signal received but already traded today. Skipping.`);
      return;
    }

    const positionCount = Object.keys(state.positions).length;
    if (positionCount > 0) {
      logger.info('Already have an open position — no second buy allowed');
      notifier.notify('SIGNAL_RECEIVED', `ENTRY signal ignored — already holding a position.`);
      return;
    }

    const existingPositions = await this.getAlpacaPositions();
    if (existingPositions.length > 0) {
      logger.info(`Alpaca already has ${existingPositions.length} position(s) — skipping entry`);
      notifier.notify('SIGNAL_RECEIVED', `ENTRY signal received but already have position(s). Skipping.`);
      return;
    }

    const occSymbol = this.buildOCCSymbol(signal);
    logger.info(`ENTRY: ${occSymbol} — ${signal.ticker} ${signal.direction} $${signal.strikePrice} @ $${signal.entryPrice}`);

    state.pendingEntry = {
      symbol: occSymbol,
      signalPrice: signal.entryPrice,
      ticker: signal.ticker,
      strike: signal.strikePrice,
      type: signal.direction,
      expiration: this.getTodayExpiration(),
    };
    this.writeState(state);

    notifier.notify('SIGNAL_RECEIVED',
      `ENTRY: ${signal.ticker} $${signal.strikePrice} ${signal.direction.toUpperCase()} @ $${signal.entryPrice} — pending execution`
    );

    await this.executeEntry(state, signal, occSymbol);
  }

  private async executeEntry(state: TradingState, signal: TradeSignal, occSymbol: string): Promise<void> {
    if (this.entryInProgress) {
      logger.info('Entry already in progress — skipping duplicate executeEntry call');
      return;
    }
    this.entryInProgress = true;

    try {
      try {
        await this.alpaca.cancelAllOrders();
        logger.info('Cancelled all open orders before new entry');
      } catch (e: any) {
        logger.warn(`Could not cancel open orders: ${e.message}`);
      }

      const existingPositions = await this.getAlpacaPositions();
      if (existingPositions.length > 0) {
        logger.info(`Alpaca already has position(s) right before order submit — aborting entry`);
        delete state.pendingEntry;
        this.writeState(state);
        return;
      }

      const budget = BUDGET_FLAT;
      const limitPrice = Math.round(signal.entryPrice * MAX_ENTRY_MULTIPLIER * 100) / 100;
      const pricePerContract = limitPrice * 100;
      let qty = Math.floor(budget / pricePerContract);
      qty = Math.max(qty, 1);
      qty = Math.min(qty, 500);

      logger.info(`Submitting order: BUY ${qty}x ${occSymbol} (limit $${limitPrice}, budget=$${budget})`);

      const order = await this.alpaca.createOrder({
        symbol: occSymbol,
        qty,
        side: 'buy',
        type: 'limit',
        limit_price: String(limitPrice),
        time_in_force: 'day',
      });

      notifier.notify('TRADE_OPENED',
        `ORDER SUBMITTED: BUY ${qty}x ${signal.ticker} $${signal.strikePrice} ${signal.direction.toUpperCase()} @ limit $${limitPrice} (signal $${signal.entryPrice}) — Order: ${order.id}. Waiting for fill...`
      );

      const fill = await this.waitForFill(order.id);

      if (!fill.filled) {
        notifier.notify('ERROR', `Entry order ${order.id} did NOT fill within timeout. No position opened.`);
        delete state.pendingEntry;
        this.writeState(state);
        return;
      }

      const actualPrice = fill.avgPrice ?? signal.entryPrice;
      const actualQty = fill.filledQty || qty;

      const position: GuruPosition = {
        symbol: occSymbol,
        ticker: signal.ticker,
        strike: signal.strikePrice,
        type: signal.direction,
        expiration: this.getTodayExpiration(),
        signalPrice: signal.entryPrice,
        entryPrice: actualPrice,
        qty: actualQty,
        entryTime: new Date().toISOString(),
        halfSold: false,
        guruMessages: [`entry signal @ $${signal.entryPrice}, filled @ $${actualPrice}`],
      };

      state.positions[occSymbol] = position;
      state.boughtToday = true;
      delete state.pendingEntry;
      this.writeState(state);

      const totalCost = (actualPrice * actualQty * 100).toFixed(0);
      const slippage = actualPrice !== signal.entryPrice
        ? ` (signal: $${signal.entryPrice}, slippage: ${((actualPrice - signal.entryPrice) / signal.entryPrice * 100).toFixed(1)}%)`
        : '';

      notifier.notify('TRADE_OPENED',
        `FILLED: ${actualQty}x ${signal.ticker} $${signal.strikePrice} ${signal.direction.toUpperCase()} @ $${actualPrice.toFixed(4)} ($${totalCost})${slippage}`
      );

      logger.info(`Entry complete: ${actualQty}x ${occSymbol} @ $${actualPrice} (signal was $${signal.entryPrice})`);
    } catch (err: any) {
      const isMarketHoursError = err.message?.includes('market hours') || err.message?.includes('market is not open');
      if (isMarketHoursError && state.pendingEntry) {
        logger.warn(`Entry failed (market not open) — keeping pendingEntry for retry when market opens`);
        notifier.notify('TRADE_UPDATE',
          `Entry for ${signal.ticker} $${signal.strikePrice} ${signal.direction.toUpperCase()} queued — market not open yet. Will auto-retry at 6:30 AM PST.`
        );
      } else {
        logger.error(`Entry execution failed: ${err.message}`);
        notifier.notify('ERROR', `Entry failed: ${err.message}`);
      }
    } finally {
      this.entryInProgress = false;
    }
  }

  // --- SCALE_IN ---

  private handleScaleIn(state: TradingState, msg: ClassifiedMessage): void {
    const posKey = Object.keys(state.positions)[0];
    const pos = posKey ? state.positions[posKey] : null;

    if (msg.signal) {
      const summary = `${msg.signal.ticker} $${msg.signal.strikePrice} ${msg.signal.direction} @ $${msg.signal.entryPrice}`;
      if (pos) {
        pos.guruMessages.push(`scale-in: ${summary}`);
        this.writeState(state);
      }
      notifier.notify('SIGNAL_RECEIVED', `SCALE IN signal (not executing): Guru adding — ${summary}. Holding current position.`);
    } else {
      if (pos) {
        pos.guruMessages.push(`scale-in mention: "${msg.raw.substring(0, 60)}"`);
        this.writeState(state);
      }
      notifier.notify('SIGNAL_RECEIVED', `Guru adding to position: "${msg.raw.substring(0, 80)}". Holding.`);
    }
  }

  // --- UPDATE ---

  private async handleUpdate(state: TradingState, msg: ClassifiedMessage): Promise<void> {
    const posKey = Object.keys(state.positions)[0];
    const pos = posKey ? state.positions[posKey] : null;

    let priceInfo = '';
    if (pos) {
      const lookup = await this.lookupAlpacaPosition(pos.symbol);
      if (lookup.status === 'found') {
        const current = parseFloat(lookup.position.current_price);
        const pct = ((current - pos.entryPrice) / pos.entryPrice * 100).toFixed(1);
        priceInfo = ` | Position: ${pos.ticker} $${pos.strike}${pos.type[0].toUpperCase()} now $${current.toFixed(2)} (${pct}%)`;
      }

      pos.guruMessages.push(`update: "${msg.raw.substring(0, 60)}"`);
      this.writeState(state);
    }

    const gainStr = msg.mentionedGainPercent ? ` (${msg.mentionedGainPercent}% gain mentioned)` : '';
    notifier.notify('TRADE_UPDATE',
      `GURU: "${msg.raw.substring(0, 100)}"${gainStr}${priceInfo}`
    );
  }

  // --- PARTIAL EXIT ---

  async handlePartialExit(state: TradingState, msg: ClassifiedMessage): Promise<void> {
    if (this.exitInProgress) {
      logger.info('Exit already in progress — skipping duplicate partial exit');
      return;
    }

    const posKey = Object.keys(state.positions)[0];
    if (!posKey) {
      logger.info('PARTIAL_EXIT signal but no open position');
      notifier.notify('TRADE_UPDATE', `Guru says sell half but we have no position`);
      return;
    }

    const pos = state.positions[posKey];
    if (pos.halfSold) {
      logger.info('Already sold half — treating as FULL_EXIT');
      await this.handleFullExit(state, msg);
      return;
    }

    this.exitInProgress = true;
    const halfQty = Math.floor(pos.qty / 2);
    if (halfQty < 1) {
      logger.warn('Position too small to sell half');
      this.exitInProgress = false;
      return;
    }

    try {
      try { await this.alpaca.cancelAllOrders(); } catch (_) {}

      const result = await this.sellWithVerification(pos.symbol, halfQty, 'partial-exit');

      if (result.filledQty > 0) {
        pos.qty -= result.filledQty;
        pos.halfSold = true;
        pos.guruMessages.push(`sold half (${result.filledQty}x) on guru signal`);
        delete state.pendingSell;
        this.writeState(state);

        notifier.notify('TRADE_CLOSED',
          `SOLD HALF: ${result.filledQty}x ${pos.ticker} $${pos.strike} ${pos.type.toUpperCase()} @ $${result.avgPrice?.toFixed(4) ?? '?'} — keeping ${pos.qty} runners`
        );

        this.postSellReconciliation(pos.symbol, posKey, state).catch(() => {});
        return;
      }

      state.pendingSell = { type: 'half', retryCount: SELL_RETRY_ATTEMPTS, firstAttempt: new Date().toISOString() };
      this.writeState(state);
      notifier.notify('ERROR',
        `Sell half FAILED after ${SELL_RETRY_ATTEMPTS} attempts. Will retry every 10s via safety check. Position still open.`
      );
    } finally {
      this.exitInProgress = false;
    }
  }

  // --- FULL EXIT ---

  async handleFullExit(state: TradingState, msg: ClassifiedMessage): Promise<void> {
    if (this.exitInProgress) {
      logger.info('Exit already in progress — skipping duplicate full exit');
      return;
    }

    const posKey = Object.keys(state.positions)[0];
    if (!posKey) {
      logger.info('FULL_EXIT signal but no open position');
      notifier.notify('TRADE_UPDATE', `Guru says sell all but we have no position`);
      return;
    }

    this.exitInProgress = true;
    const pos = state.positions[posKey];
    const originalQty = pos.qty;

    try {
      try { await this.alpaca.cancelAllOrders(); } catch (_) {}

      const result = await this.sellWithVerification(pos.symbol, pos.qty, 'full-exit');

      if (result.filledQty > 0) {
        state.closedToday.push({
          symbol: pos.symbol,
          qty: result.filledQty,
          entryPrice: pos.entryPrice,
          exitReason: 'guru-full-exit',
          exitTime: new Date().toISOString(),
        });

        pos.guruMessages.push(`sold ${result.filledQty}x on guru signal`);

        if (result.remainingQty <= 0) {
          delete state.positions[posKey];
          delete state.pendingSell;
          this.writeState(state);
          notifier.notify('TRADE_CLOSED',
            `SOLD ALL: ${result.filledQty}x ${pos.ticker} $${pos.strike} ${pos.type.toUpperCase()} @ $${result.avgPrice?.toFixed(4) ?? '?'} — guru exit`
          );
          this.postSellReconciliation(pos.symbol, posKey, state).catch(() => {});
        } else {
          pos.qty = result.remainingQty;
          state.pendingSell = { type: 'all', retryCount: SELL_RETRY_ATTEMPTS, firstAttempt: new Date().toISOString() };
          this.writeState(state);
          notifier.notify('ERROR',
            `PARTIAL SELL: ${result.filledQty}/${originalQty} filled. ${result.remainingQty} contracts remaining. Will retry via safety check.`
          );
        }
        return;
      }

      state.pendingSell = { type: 'all', retryCount: SELL_RETRY_ATTEMPTS, firstAttempt: new Date().toISOString() };
      this.writeState(state);
      notifier.notify('ERROR',
        `Sell all FAILED after ${SELL_RETRY_ATTEMPTS} attempts. Will retry every 10s via safety check. Position still open.`
      );
    } finally {
      this.exitInProgress = false;
    }
  }

  // --- SAFETY CHECKS (called externally on a timer) ---

  async runSafetyChecks(): Promise<void> {
    const state = this.readState();
    const now = new Date();
    const pst = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
    const pstHour = pst.getHours();
    const pstMin = pst.getMinutes();
    const pstTotalMin = pstHour * 60 + pstMin;

    // --- Pre-market entry queue: retry pending entry when market opens ---
    if (state.pendingEntry) {
      const marketOpenMin = MARKET_OPEN_HOUR * 60 + MARKET_OPEN_MINUTE;
      const deadlineMin = PENDING_ENTRY_DEADLINE_HOUR * 60 + PENDING_ENTRY_DEADLINE_MINUTE;

      if (pstTotalMin >= deadlineMin) {
        logger.info(`Pending entry expired (past ${PENDING_ENTRY_DEADLINE_HOUR}:${String(PENDING_ENTRY_DEADLINE_MINUTE).padStart(2, '0')} AM PST) — cancelling`);
        notifier.notify('ERROR', `Pending entry for ${state.pendingEntry.ticker} cancelled — past deadline.`);
        delete state.pendingEntry;
        this.writeState(state);
      } else if (pstTotalMin >= marketOpenMin && Object.keys(state.positions).length === 0 && !this.entryInProgress && !state.boughtToday && state.closedToday.length === 0) {
        logger.info(`Market open — retrying pending entry for ${state.pendingEntry.symbol}`);
        const entry = state.pendingEntry;
        const signal = {
          raw: `retry pending entry ${entry.symbol}`,
          ticker: entry.ticker,
          direction: entry.type,
          strikePrice: entry.strike,
          entryPrice: entry.signalPrice,
          timestamp: new Date(),
          messageId: `pending-retry-${Date.now()}`,
        };
        await this.executeEntry(state, signal, entry.symbol);
      }
    }

    // --- Pending sell retry: if a guru sell signal failed, keep retrying ---
    if (state.pendingSell) {
      const posKey = Object.keys(state.positions)[0];
      if (posKey) {
        const pos = state.positions[posKey];
        state.pendingSell.retryCount++;
        logger.info(`Retrying pending ${state.pendingSell.type} sell (attempt ${state.pendingSell.retryCount})`);

        try {
          const qty = state.pendingSell.type === 'half' ? Math.floor(pos.qty / 2) : pos.qty;
          if (qty >= 1) {
            const order = await this.alpaca.createOrder({
              symbol: pos.symbol,
              qty,
              side: 'sell',
              type: 'market',
              time_in_force: 'day',
            });

            if (state.pendingSell.type === 'half') {
              pos.qty -= qty;
              pos.halfSold = true;
              pos.guruMessages.push(`sold half (${qty}x) on retry`);
              notifier.notify('TRADE_CLOSED', `SOLD HALF (retry success): ${qty}x ${pos.ticker} $${pos.strike} ${pos.type.toUpperCase()}. Order: ${order.id}`);
            } else {
              state.closedToday.push({
                symbol: pos.symbol, qty: pos.qty, entryPrice: pos.entryPrice,
                exitReason: 'guru-full-exit-retry', exitTime: new Date().toISOString(),
              });
              pos.guruMessages.push(`sold all (${qty}x) on retry`);
              delete state.positions[posKey];
              notifier.notify('TRADE_CLOSED', `SOLD ALL (retry success): ${qty}x ${pos.ticker} $${pos.strike} ${pos.type.toUpperCase()}. Order: ${order.id}`);
            }
            delete state.pendingSell;
            this.writeState(state);
            return;
          }
        } catch (err: any) {
          logger.error(`Pending sell retry failed: ${err.message}`);
        }
        this.writeState(state);
      } else {
        delete state.pendingSell;
        this.writeState(state);
      }
    }

    // --- Position checks ---
    const posKey = Object.keys(state.positions)[0];
    if (!posKey) return;

    const pos = state.positions[posKey];

    // Force close at 12:40 PM PST — the ONLY automated exit
    if (pstHour > FORCE_CLOSE_HOUR ||
        (pstHour === FORCE_CLOSE_HOUR && pstMin >= FORCE_CLOSE_MINUTE)) {
      logger.info('12:40 PM PST — force closing all positions');
      await this.forceCloseAll(state, 'eod-force-close');
      return;
    }

    // Check if position still exists on Alpaca.
    // CRITICAL: Only delete on CONFIRMED 404 (3 consecutive), never on transient errors.
    const lookup = await this.lookupAlpacaPosition(pos.symbol);

    if (lookup.status === 'found') {
      this.consecutiveNotFound.delete(posKey);
      return;
    }

    if (lookup.status === 'error') {
      logger.warn(`Safety check: transient API error for ${pos.symbol}: ${lookup.message}. Keeping position in state.`);
      return;
    }

    const count = (this.consecutiveNotFound.get(posKey) || 0) + 1;
    this.consecutiveNotFound.set(posKey, count);

    if (count < 3) {
      logger.warn(`Position ${pos.symbol} not found on Alpaca (${count}/3 before removal). Could be transient.`);
      return;
    }

    logger.warn(`Position ${pos.symbol} confirmed gone from Alpaca after 3 consecutive 404s. Removing from state.`);
    this.consecutiveNotFound.delete(posKey);
    delete state.positions[posKey];
    this.writeState(state);
    notifier.notify('TRADE_UPDATE', `Position ${pos.ticker} $${pos.strike} ${pos.type.toUpperCase()} removed from tracking — confirmed closed on Alpaca.`);
  }

  // --- RECONCILIATION: sync local state with actual Alpaca positions ---

  async reconcileWithAlpaca(): Promise<void> {
    const state = this.readState();
    let changed = false;

    let alpacaPositions: Position[];
    try {
      alpacaPositions = await this.alpaca.getPositions();
    } catch (err: any) {
      logger.warn(`Reconciliation skipped — could not fetch Alpaca positions: ${err.message}`);
      return;
    }

    const alpacaBySymbol = new Map(alpacaPositions.map(p => [p.symbol, p]));

    // 1. Alpaca has positions NOT in our state → recover them
    for (const [symbol, alpPos] of alpacaBySymbol) {
      if (!state.positions[symbol]) {
        const isOption = symbol.length > 6;
        if (!isOption) continue;

        logger.warn(`Reconciliation: found orphaned Alpaca position ${symbol} — adding to state`);
        const qty = parseInt(alpPos.qty, 10);
        const avgEntry = parseFloat(alpPos.avg_entry_price);
        const ticker = symbol.replace(/\d.*/, '');

        state.positions[symbol] = {
          symbol,
          ticker,
          strike: 0,
          type: 'call',
          expiration: '',
          signalPrice: avgEntry,
          entryPrice: avgEntry,
          qty,
          entryTime: new Date().toISOString(),
          halfSold: false,
          guruMessages: ['recovered by reconciliation'],
        };
        changed = true;

        notifier.notify('TRADE_UPDATE',
          `RECOVERED orphaned position: ${qty}x ${symbol} @ $${avgEntry.toFixed(2)}. Now tracking.`
        );
      }
    }

    // 2. State has positions NOT on Alpaca → verify before removing
    for (const [symbol, pos] of Object.entries(state.positions)) {
      if (!alpacaBySymbol.has(symbol)) {
        const count = (this.consecutiveNotFound.get(symbol) || 0) + 1;
        this.consecutiveNotFound.set(symbol, count);

        if (count >= 3) {
          logger.warn(`Reconciliation: ${symbol} gone from Alpaca (3 consecutive checks). Removing from state.`);
          this.consecutiveNotFound.delete(symbol);
          state.closedToday.push({
            symbol: pos.symbol,
            qty: pos.qty,
            entryPrice: pos.entryPrice,
            exitReason: 'reconciliation-removed',
            exitTime: new Date().toISOString(),
          });
          delete state.positions[symbol];
          changed = true;
          notifier.notify('TRADE_UPDATE', `Position ${pos.ticker} $${pos.strike} ${pos.type.toUpperCase()} removed — no longer on Alpaca.`);
        } else {
          logger.warn(`Reconciliation: ${symbol} not found on Alpaca (${count}/3). Keeping in state for now.`);
        }
      } else {
        this.consecutiveNotFound.delete(symbol);

        // Sync qty from Alpaca if it differs (e.g., partial fill from external sell)
        const alpQty = parseInt(alpacaBySymbol.get(symbol)!.qty, 10);
        if (alpQty !== pos.qty) {
          logger.info(`Reconciliation: syncing qty for ${symbol}: state=${pos.qty} → alpaca=${alpQty}`);
          pos.qty = alpQty;
          changed = true;
        }
      }
    }

    if (changed) {
      this.writeState(state);
      logger.info('Reconciliation: state updated');
    }
  }

  async forceCloseAll(state: TradingState, reason: string): Promise<void> {
    if (this.exitInProgress) {
      logger.info('Exit already in progress — skipping force close');
      return;
    }
    this.exitInProgress = true;
    const CHUNK_SIZE = 50;
    const EOD_DEADLINE_MIN = 12 * 60 + 55;

    try {
      try { await this.alpaca.cancelAllOrders(); } catch (_) {}

      for (const [key, pos] of Object.entries(state.positions)) {
        let remainingQty = pos.qty;

        const result = await this.sellWithVerification(pos.symbol, remainingQty, `eod-close-${pos.ticker}`);
        remainingQty -= result.filledQty;

        if (remainingQty > 0) {
          logger.warn(`EOD: ${result.filledQty}/${pos.qty} filled for ${pos.symbol}. Chunking remaining ${remainingQty}...`);
          while (remainingQty > 0) {
            const now = new Date();
            const pst = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
            if (pst.getHours() * 60 + pst.getMinutes() >= EOD_DEADLINE_MIN) {
              logger.warn(`EOD deadline (12:55 PM) reached with ${remainingQty} contracts remaining. Using closePosition fallback.`);
              break;
            }

            const chunkQty = Math.min(remainingQty, CHUNK_SIZE);
            const chunkResult = await this.sellWithVerification(pos.symbol, chunkQty, `eod-chunk-${pos.ticker}`);
            remainingQty -= chunkResult.filledQty;

            if (chunkResult.filledQty === 0) {
              logger.warn(`EOD chunk got 0 fills for ${pos.symbol}. Trying closePosition fallback.`);
              break;
            }
          }
        }

        if (remainingQty > 0) {
          logger.warn(`EOD: Using closePosition() fallback for ${pos.symbol} (${remainingQty} remaining)`);
          try {
            await this.alpaca.closePosition(pos.symbol);
            logger.info(`closePosition() succeeded for ${pos.symbol}`);
            remainingQty = 0;
          } catch (err: any) {
            logger.error(`closePosition() fallback failed for ${pos.symbol}: ${err.message}`);
          }
        }

        const soldQty = pos.qty - remainingQty;
        if (soldQty > 0) {
          state.closedToday.push({
            symbol: pos.symbol,
            qty: soldQty,
            entryPrice: pos.entryPrice,
            exitReason: reason,
            exitTime: new Date().toISOString(),
          });
        }

        if (remainingQty <= 0) {
          notifier.notify('TRADE_CLOSED',
            `SAFETY CLOSE (${reason}): Sold ${pos.qty}x ${pos.ticker} $${pos.strike} ${pos.type.toUpperCase()}`
          );
          delete state.positions[key];
        } else {
          pos.qty = remainingQty;
          notifier.notify('ERROR',
            `EOD CLOSE INCOMPLETE: ${soldQty}/${pos.qty + soldQty} sold for ${pos.ticker}. ${remainingQty} contracts may still be open. Manual check needed.`
          );
        }
      }

      this.writeState(state);

      setTimeout(async () => {
        try {
          const positions = await this.alpaca.getPositions();
          if (positions.length > 0) {
            logger.warn(`Post-EOD reconciliation: ${positions.length} position(s) still on Alpaca`);
            for (const p of positions) {
              logger.warn(`  Orphaned: ${p.symbol} qty=${p.qty}`);
              try {
                await this.alpaca.closePosition(p.symbol);
                logger.info(`  Closed orphaned position ${p.symbol}`);
              } catch (err: any) {
                logger.error(`  Failed to close orphaned ${p.symbol}: ${err.message}`);
                notifier.notify('ERROR', `CRITICAL: Orphaned position ${p.symbol} (${p.qty}x) could not be closed after EOD. Manual intervention needed.`);
              }
            }
          } else {
            logger.info('Post-EOD reconciliation: all positions confirmed closed on Alpaca');
          }
        } catch (err: any) {
          logger.warn(`Post-EOD reconciliation check failed: ${err.message}`);
        }
      }, 5000);
    } finally {
      this.exitInProgress = false;
    }
  }

  async resetForNewDay(): Promise<void> {
    const state: TradingState = {
      positions: {},
      closedToday: [],
      boughtToday: false,
      dayTradesUsed: 0,
    };
    this.writeState(state);
    this.processedMessages.clear();
    logger.info('State reset for new trading day');
  }

  // --- Order Fill Verification ---

  private async waitForFill(orderId: string): Promise<{ filled: boolean; avgPrice: number | null; filledQty: number }> {
    const start = Date.now();
    while (Date.now() - start < FILL_TIMEOUT_MS) {
      try {
        const order = await this.alpaca.getOrder(orderId);
        if (order.status === 'filled') {
          return {
            filled: true,
            avgPrice: order.filled_avg_price ? parseFloat(order.filled_avg_price) : null,
            filledQty: parseInt(order.filled_qty, 10),
          };
        }
        if (order.status === 'canceled' || order.status === 'expired' || order.status === 'rejected') {
          logger.warn(`Order ${orderId} ended with status: ${order.status}`);
          return { filled: false, avgPrice: null, filledQty: 0 };
        }
      } catch (err: any) {
        logger.warn(`Error polling order ${orderId}: ${err.message}`);
      }
      await new Promise(r => setTimeout(r, FILL_POLL_INTERVAL_MS));
    }

    logger.warn(`Order ${orderId} not filled within ${FILL_TIMEOUT_MS}ms — checking final status`);
    try {
      const order = await this.alpaca.getOrder(orderId);
      if (order.status === 'filled') {
        return {
          filled: true,
          avgPrice: order.filled_avg_price ? parseFloat(order.filled_avg_price) : null,
          filledQty: parseInt(order.filled_qty, 10),
        };
      }
      if (order.status === 'partially_filled') {
        return {
          filled: true,
          avgPrice: order.filled_avg_price ? parseFloat(order.filled_avg_price) : null,
          filledQty: parseInt(order.filled_qty, 10),
        };
      }
      // Still pending — cancel it
      logger.warn(`Order ${orderId} still ${order.status} after timeout — cancelling`);
      await this.alpaca.cancelOrder(orderId);
      notifier.notify('ERROR', `Order ${orderId} cancelled — did not fill within ${FILL_TIMEOUT_MS / 1000}s`);
      return { filled: false, avgPrice: null, filledQty: 0 };
    } catch (err: any) {
      logger.error(`Error checking/cancelling order ${orderId}: ${err.message}`);
      return { filled: false, avgPrice: null, filledQty: 0 };
    }
  }

  private async waitForSellFill(
    orderId: string,
    expectedQty: number,
  ): Promise<{ filledQty: number; remainingQty: number; avgPrice: number | null }> {
    const start = Date.now();
    while (Date.now() - start < FILL_TIMEOUT_MS) {
      try {
        const order = await this.alpaca.getOrder(orderId);
        const filled = parseInt(order.filled_qty, 10) || 0;

        if (order.status === 'filled') {
          return {
            filledQty: filled,
            remainingQty: Math.max(0, expectedQty - filled),
            avgPrice: order.filled_avg_price ? parseFloat(order.filled_avg_price) : null,
          };
        }
        if (order.status === 'canceled' || order.status === 'expired' || order.status === 'rejected') {
          logger.warn(`Sell order ${orderId} ended with status: ${order.status}, filled ${filled}/${expectedQty}`);
          return { filledQty: filled, remainingQty: expectedQty - filled, avgPrice: order.filled_avg_price ? parseFloat(order.filled_avg_price) : null };
        }
      } catch (err: any) {
        logger.warn(`Error polling sell order ${orderId}: ${err.message}`);
      }
      await new Promise(r => setTimeout(r, FILL_POLL_INTERVAL_MS));
    }

    logger.warn(`Sell order ${orderId} not fully filled within ${FILL_TIMEOUT_MS}ms — checking final status`);
    try {
      const order = await this.alpaca.getOrder(orderId);
      const filled = parseInt(order.filled_qty, 10) || 0;

      if (order.status === 'filled') {
        return { filledQty: filled, remainingQty: 0, avgPrice: order.filled_avg_price ? parseFloat(order.filled_avg_price) : null };
      }

      if (order.status === 'partially_filled' && filled > 0) {
        logger.info(`Sell order ${orderId} partially filled: ${filled}/${expectedQty}. Cancelling remainder.`);
        try { await this.alpaca.cancelOrder(orderId); } catch (_) {}
        return { filledQty: filled, remainingQty: expectedQty - filled, avgPrice: order.filled_avg_price ? parseFloat(order.filled_avg_price) : null };
      }

      logger.warn(`Sell order ${orderId} still ${order.status} after timeout — cancelling`);
      try { await this.alpaca.cancelOrder(orderId); } catch (_) {}
      return { filledQty: filled, remainingQty: expectedQty - filled, avgPrice: null };
    } catch (err: any) {
      logger.error(`Error checking sell order ${orderId}: ${err.message}`);
      return { filledQty: 0, remainingQty: expectedQty, avgPrice: null };
    }
  }

  private async sellWithVerification(
    symbol: string,
    qty: number,
    label: string,
  ): Promise<{ filledQty: number; remainingQty: number; avgPrice: number | null }> {
    let totalFilled = 0;
    let remainingQty = qty;
    let lastAvgPrice: number | null = null;

    for (let attempt = 1; attempt <= SELL_RETRY_ATTEMPTS && remainingQty > 0; attempt++) {
      try {
        const order = await this.alpaca.createOrder({
          symbol,
          qty: remainingQty,
          side: 'sell',
          type: 'market',
          time_in_force: 'day',
        });

        const result = await this.waitForSellFill(order.id, remainingQty);
        totalFilled += result.filledQty;
        remainingQty = qty - totalFilled;
        if (result.avgPrice) lastAvgPrice = result.avgPrice;

        if (result.filledQty > 0) {
          logger.info(`${label} attempt ${attempt}: sold ${result.filledQty}/${remainingQty + result.filledQty} (total filled: ${totalFilled}/${qty})`);
          notifier.notify('TRADE_UPDATE',
            `SELL PROGRESS: ${totalFilled}/${qty} contracts filled${remainingQty > 0 ? `, retrying ${remainingQty} remaining...` : ' — all done'}`
          );
        }

        if (remainingQty <= 0) break;

        if (result.filledQty === 0) {
          logger.warn(`${label} attempt ${attempt}: no fills. Retrying in ${SELL_RETRY_DELAY_MS}ms...`);
          await new Promise(r => setTimeout(r, SELL_RETRY_DELAY_MS));
        }
      } catch (err: any) {
        logger.error(`${label} attempt ${attempt}/${SELL_RETRY_ATTEMPTS} failed: ${err.message}`);
        if (attempt < SELL_RETRY_ATTEMPTS) {
          await new Promise(r => setTimeout(r, SELL_RETRY_DELAY_MS));
        }
      }
    }

    return { filledQty: totalFilled, remainingQty: qty - totalFilled, avgPrice: lastAvgPrice };
  }

  private async postSellReconciliation(symbol: string, posKey: string, state: TradingState): Promise<void> {
    await new Promise(r => setTimeout(r, 5000));
    try {
      const positions = await this.alpaca.getPositions();
      const remaining = positions.find(p => p.symbol === symbol);
      if (remaining) {
        const remainingQty = parseInt(remaining.qty, 10);
        if (remainingQty > 0) {
          logger.warn(`Post-sell reconciliation: ${remainingQty} contracts of ${symbol} still on Alpaca. Retrying sell...`);
          notifier.notify('ERROR', `Orphaned contracts detected: ${remainingQty}x ${symbol}. Retrying sell...`);

          const result = await this.sellWithVerification(symbol, remainingQty, 'reconciliation-sell');
          if (result.remainingQty > 0) {
            logger.warn(`Reconciliation: still ${result.remainingQty} contracts remaining. Using closePosition fallback.`);
            try {
              await this.alpaca.closePosition(symbol);
              logger.info(`closePosition fallback succeeded for ${symbol}`);
            } catch (err: any) {
              logger.error(`closePosition fallback failed: ${err.message}`);
              notifier.notify('ERROR', `CRITICAL: ${result.remainingQty}x ${symbol} could not be closed. Manual intervention needed.`);
            }
          }

          if (state.positions[posKey]) {
            state.positions[posKey].qty = result.remainingQty;
            if (result.remainingQty <= 0) {
              delete state.positions[posKey];
            }
            this.writeState(state);
          }
        }
      }
    } catch (err: any) {
      logger.warn(`Post-sell reconciliation check failed: ${err.message}`);
    }
  }

  // --- Helpers ---

  private buildOCCSymbol(signal: TradeSignal): string {
    const ticker = signal.ticker.toUpperCase().padEnd(6, ' ');
    const exp = this.getTodayExpiration();
    const type = signal.direction === 'call' ? 'C' : 'P';
    const strike = Math.round(signal.strikePrice * 1000).toString().padStart(8, '0');
    return `${signal.ticker}${exp}${type}${strike}`;
  }

  private getTodayExpiration(): string {
    const now = new Date();
    const pst = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
    const yy = pst.getFullYear().toString().slice(-2);
    const mm = (pst.getMonth() + 1).toString().padStart(2, '0');
    const dd = pst.getDate().toString().padStart(2, '0');
    return `${yy}${mm}${dd}`;
  }

  private async getAlpacaPositions(): Promise<Position[]> {
    try {
      return await this.alpaca.getPositions();
    } catch {
      return [];
    }
  }

  private async lookupAlpacaPosition(symbol: string): Promise<PositionLookup> {
    try {
      const position = await this.alpaca.getPosition(symbol);
      return { status: 'found', position };
    } catch (err: any) {
      if (err instanceof AlpacaError && err.isNotFound) {
        return { status: 'not_found' };
      }
      return { status: 'error', message: err.message || 'Unknown error' };
    }
  }
}
