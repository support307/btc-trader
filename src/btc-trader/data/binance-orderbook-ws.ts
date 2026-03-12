import WebSocket from 'ws';
import { btcConfig } from '../config';
import { logger } from '../clock/logger';

interface DepthLevel {
  price: number;
  qty: number;
}

interface OFIEvent {
  timestamp: number;
  increment: number;
}

const MAX_LEVELS = 20;
const MAX_OFI_EVENTS = 30_000;
const RECONNECT_DELAY = 3000;
const SNAPSHOT_URL = `${btcConfig.binance.restUrl}/api/v3/depth?symbol=BTCUSDT&limit=${MAX_LEVELS}`;
const WS_URL = 'wss://stream.binance.com:9443/ws/btcusdt@depth@100ms';

/**
 * Maintains a local Binance BTCUSDT L2 order book from the depth@100ms stream,
 * following Binance's official book-sync protocol:
 *   1. Buffer WS events
 *   2. REST snapshot
 *   3. Drop events with U <= lastUpdateId
 *   4. Apply events where U <= lastUpdateId+1 <= u
 *   5. Re-snapshot on sequence break
 *
 * Computes OFI (Order Flow Imbalance) on every update by tracking
 * changes at the best bid/ask.
 */
export class BinanceOrderBookFeed {
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private connected = false;
  private synced = false;

  private bids: Map<number, number> = new Map();
  private asks: Map<number, number> = new Map();
  private lastUpdateId = 0;
  private bufferedEvents: any[] = [];

  private prevBestBidPx = 0;
  private prevBestBidQty = 0;
  private prevBestAskPx = 0;
  private prevBestAskQty = 0;

  private ofiEvents: OFIEvent[] = [];

  get isConnected(): boolean { return this.connected; }
  get isSynced(): boolean { return this.synced; }

  start(): void {
    this.connectWs();
  }

  stop(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.synced = false;
  }

  private connectWs(): void {
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
    }

    this.synced = false;
    this.bufferedEvents = [];

    this.ws = new WebSocket(WS_URL);

    this.ws.on('open', () => {
      this.connected = true;
      logger.info('Binance L2 depth WebSocket connected');
      this.fetchSnapshot();
    });

    this.ws.on('message', (raw: Buffer) => {
      try {
        const event = JSON.parse(raw.toString());
        if (!this.synced) {
          this.bufferedEvents.push(event);
        } else {
          this.applyEvent(event);
        }
      } catch { /* skip malformed */ }
    });

    this.ws.on('close', () => {
      this.connected = false;
      this.synced = false;
      logger.warn('Binance L2 depth WebSocket closed, reconnecting...');
      this.scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      logger.error(`Binance L2 depth WS error: ${err.message}`);
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectWs();
    }, RECONNECT_DELAY);
  }

  private async fetchSnapshot(): Promise<void> {
    try {
      const res = await fetch(SNAPSHOT_URL, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`Snapshot HTTP ${res.status}`);
      const data = await res.json() as any;

      this.bids.clear();
      this.asks.clear();

      for (const [px, qty] of data.bids) {
        const p = parseFloat(px);
        const q = parseFloat(qty);
        if (q > 0) this.bids.set(p, q);
      }
      for (const [px, qty] of data.asks) {
        const p = parseFloat(px);
        const q = parseFloat(qty);
        if (q > 0) this.asks.set(p, q);
      }

      this.lastUpdateId = data.lastUpdateId;
      this.initBestQuotes();

      for (const evt of this.bufferedEvents) {
        if (evt.u <= this.lastUpdateId) continue;
        if (evt.U > this.lastUpdateId + 1) {
          logger.warn('Binance L2: sequence gap in buffered events, re-snapshotting');
          this.bufferedEvents = [];
          setTimeout(() => this.fetchSnapshot(), 1000);
          return;
        }
        this.applyEvent(evt);
      }
      this.bufferedEvents = [];
      this.synced = true;
      logger.info(`Binance L2 book synced (${this.bids.size} bids, ${this.asks.size} asks)`);
    } catch (err: any) {
      logger.error(`Binance L2 snapshot failed: ${err.message}`);
      setTimeout(() => this.fetchSnapshot(), 3000);
    }
  }

  private applyEvent(event: any): void {
    if (event.u <= this.lastUpdateId) return;

    if (event.U > this.lastUpdateId + 1) {
      logger.warn('Binance L2: sequence break, re-syncing');
      this.synced = false;
      this.bufferedEvents = [];
      this.fetchSnapshot();
      return;
    }

    for (const [px, qty] of event.b || []) {
      const p = parseFloat(px);
      const q = parseFloat(qty);
      if (q === 0) this.bids.delete(p);
      else this.bids.set(p, q);
    }

    for (const [px, qty] of event.a || []) {
      const p = parseFloat(px);
      const q = parseFloat(qty);
      if (q === 0) this.asks.delete(p);
      else this.asks.set(p, q);
    }

    this.lastUpdateId = event.u;
    this.trimBook();
    this.computeOFI(event.E || Date.now());
  }

  private trimBook(): void {
    if (this.bids.size > MAX_LEVELS * 2) {
      const sorted = [...this.bids.entries()].sort((a, b) => b[0] - a[0]);
      this.bids = new Map(sorted.slice(0, MAX_LEVELS));
    }
    if (this.asks.size > MAX_LEVELS * 2) {
      const sorted = [...this.asks.entries()].sort((a, b) => a[0] - b[0]);
      this.asks = new Map(sorted.slice(0, MAX_LEVELS));
    }
  }

  private initBestQuotes(): void {
    const bb = this.getBestBid();
    const ba = this.getBestAsk();
    this.prevBestBidPx = bb.price;
    this.prevBestBidQty = bb.qty;
    this.prevBestAskPx = ba.price;
    this.prevBestAskQty = ba.qty;
  }

  /**
   * Compute OFI increment per Cont–Kukanov–Stoikov:
   *
   * Bid side:
   *   if newBidPx > oldBidPx: ofi += newBidQty
   *   if newBidPx == oldBidPx: ofi += (newBidQty - oldBidQty)
   *   if newBidPx < oldBidPx: ofi -= oldBidQty
   *
   * Ask side (inverted):
   *   if newAskPx < oldAskPx: ofi -= newAskQty
   *   if newAskPx == oldAskPx: ofi -= (newAskQty - oldAskQty)
   *   if newAskPx > oldAskPx: ofi += oldAskQty
   */
  private computeOFI(timestampMs: number): void {
    const bb = this.getBestBid();
    const ba = this.getBestAsk();

    if (bb.price === 0 || ba.price === 0) return;

    let ofi = 0;

    if (bb.price > this.prevBestBidPx) {
      ofi += bb.qty;
    } else if (bb.price === this.prevBestBidPx) {
      ofi += (bb.qty - this.prevBestBidQty);
    } else {
      ofi -= this.prevBestBidQty;
    }

    if (ba.price < this.prevBestAskPx) {
      ofi -= ba.qty;
    } else if (ba.price === this.prevBestAskPx) {
      ofi -= (ba.qty - this.prevBestAskQty);
    } else {
      ofi += this.prevBestAskQty;
    }

    this.prevBestBidPx = bb.price;
    this.prevBestBidQty = bb.qty;
    this.prevBestAskPx = ba.price;
    this.prevBestAskQty = ba.qty;

    this.ofiEvents.push({ timestamp: timestampMs, increment: ofi });
    if (this.ofiEvents.length > MAX_OFI_EVENTS) {
      this.ofiEvents = this.ofiEvents.slice(-MAX_OFI_EVENTS);
    }
  }

  // --- Public getters ---

  getBestBid(): DepthLevel {
    if (this.bids.size === 0) return { price: 0, qty: 0 };
    let bestPx = 0;
    for (const px of this.bids.keys()) {
      if (px > bestPx) bestPx = px;
    }
    return { price: bestPx, qty: this.bids.get(bestPx) || 0 };
  }

  getBestAsk(): DepthLevel {
    if (this.asks.size === 0) return { price: 0, qty: 0 };
    let bestPx = Infinity;
    for (const px of this.asks.keys()) {
      if (px < bestPx) bestPx = px;
    }
    return { price: bestPx, qty: this.asks.get(bestPx) || 0 };
  }

  getMid(): number {
    const bb = this.getBestBid();
    const ba = this.getBestAsk();
    if (bb.price === 0 || ba.price === 0) return 0;
    return (bb.price + ba.price) / 2;
  }

  getSpreadBps(): number {
    const bb = this.getBestBid();
    const ba = this.getBestAsk();
    const mid = this.getMid();
    if (mid === 0) return 0;
    return ((ba.price - bb.price) / mid) * 10_000;
  }

  /**
   * Microprice: mid adjusted by top-of-book imbalance.
   * microprice = mid + (bidImbalance - 0.5) * spread
   * where bidImbalance = bidQty / (bidQty + askQty) at best levels.
   */
  getMicroprice(): number {
    const bb = this.getBestBid();
    const ba = this.getBestAsk();
    if (bb.price === 0 || ba.price === 0) return 0;
    const mid = (bb.price + ba.price) / 2;
    const spread = ba.price - bb.price;
    const total = bb.qty + ba.qty;
    if (total === 0) return mid;
    const imbalance = bb.qty / total;
    return mid + (imbalance - 0.5) * spread;
  }

  /**
   * Microprice edge: (microprice - mid) / spread. Positive = bullish pressure.
   */
  getMicropriceEdge(): number {
    const mid = this.getMid();
    const microprice = this.getMicroprice();
    const bb = this.getBestBid();
    const ba = this.getBestAsk();
    const spread = ba.price - bb.price;
    if (spread <= 0) return 0;
    return (microprice - mid) / spread;
  }

  /**
   * Rolling OFI over a window, normalized by average top-of-book depth.
   */
  getOFI(windowMs: number): number {
    const cutoff = Date.now() - windowMs;
    let sum = 0;
    let count = 0;
    for (let i = this.ofiEvents.length - 1; i >= 0; i--) {
      if (this.ofiEvents[i].timestamp < cutoff) break;
      sum += this.ofiEvents[i].increment;
      count++;
    }
    if (count === 0) return 0;
    const avgTopDepth = (this.prevBestBidQty + this.prevBestAskQty) / 2;
    if (avgTopDepth <= 0) return sum;
    return sum / avgTopDepth;
  }

  /**
   * Depth skew at top N levels: (totalBidQty - totalAskQty) / (totalBidQty + totalAskQty).
   * Positive = more bid support (bullish), negative = more ask pressure (bearish).
   */
  getDepthSkew(levels = 10): number {
    const sortedBids = [...this.bids.entries()].sort((a, b) => b[0] - a[0]).slice(0, levels);
    const sortedAsks = [...this.asks.entries()].sort((a, b) => a[0] - b[0]).slice(0, levels);
    const bidDepth = sortedBids.reduce((s, [, q]) => s + q, 0);
    const askDepth = sortedAsks.reduce((s, [, q]) => s + q, 0);
    const total = bidDepth + askDepth;
    if (total === 0) return 0;
    return (bidDepth - askDepth) / total;
  }

  /**
   * Full book state snapshot for logging/features.
   */
  getBookState(): {
    bestBid: DepthLevel;
    bestAsk: DepthLevel;
    mid: number;
    spreadBps: number;
    microprice: number;
    micropriceEdge: number;
    depthSkew: number;
    ofi30s: number;
    ofi60s: number;
    ofi300s: number;
    synced: boolean;
  } {
    return {
      bestBid: this.getBestBid(),
      bestAsk: this.getBestAsk(),
      mid: this.getMid(),
      spreadBps: this.getSpreadBps(),
      microprice: this.getMicroprice(),
      micropriceEdge: this.getMicropriceEdge(),
      depthSkew: this.getDepthSkew(),
      ofi30s: this.getOFI(30_000),
      ofi60s: this.getOFI(60_000),
      ofi300s: this.getOFI(300_000),
      synced: this.synced,
    };
  }
}
