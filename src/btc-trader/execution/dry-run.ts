import { ExecutionAdapter } from './execution-adapter';
import { TradeOrder, TradeResult } from '../types';
import { takerFee } from '../features/fees';
import { logger } from '../clock/logger';

interface VirtualPosition {
  tokenId: string;
  direction: string;
  side: string;
  size: number;
  avgPrice: number;
  orderId: string;
}

export class DryRunAdapter implements ExecutionAdapter {
  readonly name = 'dry-run';

  private balance: number;
  private positions: VirtualPosition[] = [];
  private tradeLog: TradeResult[] = [];

  constructor(initialBalance = 1000) {
    this.balance = initialBalance;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async placeOrder(order: TradeOrder): Promise<TradeResult> {
    const cost = order.price * order.size;
    const fee = takerFee(order.price, order.size);
    const totalCost = cost + fee;

    if (totalCost > this.balance) {
      logger.warn(`[DRY-RUN] Insufficient balance: need $${totalCost.toFixed(2)}, have $${this.balance.toFixed(2)}`);
      return {
        order,
        filled: false,
        fillPrice: 0,
        fillSize: 0,
        fee: 0,
        pnl: 0,
      };
    }

    this.balance -= totalCost;
    this.positions.push({
      tokenId: order.tokenId,
      direction: order.direction,
      side: order.side,
      size: order.size,
      avgPrice: order.price,
      orderId: order.id,
    });

    const result: TradeResult = {
      order,
      filled: true,
      fillPrice: order.price,
      fillSize: order.size,
      fee,
      pnl: 0, // calculated at resolution
    };

    this.tradeLog.push(result);

    logger.info(
      `[DRY-RUN] ${order.side.toUpperCase()} ${order.size.toFixed(1)} ${order.direction} @ $${order.price.toFixed(3)} ` +
      `(fee: $${fee.toFixed(3)}, total: $${totalCost.toFixed(2)}) | Balance: $${this.balance.toFixed(2)}`
    );

    return result;
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    const idx = this.positions.findIndex((p) => p.orderId === orderId);
    if (idx >= 0) {
      const pos = this.positions[idx];
      this.balance += pos.avgPrice * pos.size; // refund
      this.positions.splice(idx, 1);
      logger.info(`[DRY-RUN] Cancelled order ${orderId}`);
      return true;
    }
    return false;
  }

  resolveWindow(outcome: 'up' | 'down'): number {
    let totalPnl = 0;
    const resolvedPositions: VirtualPosition[] = [];

    for (const pos of this.positions) {
      const isWinner = pos.direction === outcome;

      const payout = isWinner ? pos.size * 1.0 : 0;
      const pnl = payout - (pos.avgPrice * pos.size);
      this.balance += payout;
      totalPnl += pnl;
      resolvedPositions.push(pos);
    }

    this.positions = this.positions.filter(
      (p) => !resolvedPositions.includes(p)
    );

    if (resolvedPositions.length > 0) {
      logger.info(
        `[DRY-RUN] Window resolved: ${outcome}. P&L: $${totalPnl.toFixed(2)}. Balance: $${this.balance.toFixed(2)}`
      );
    }

    return totalPnl;
  }

  async getBalance(): Promise<{ available: number; currency: string }> {
    return { available: this.balance, currency: 'USDC' };
  }

  async getOpenPositions() {
    return this.positions.map((p) => ({
      tokenId: p.tokenId,
      side: p.side,
      size: p.size,
      avgPrice: p.avgPrice,
    }));
  }

  getTradeLog(): TradeResult[] {
    return [...this.tradeLog];
  }

  getStats() {
    return {
      balance: this.balance,
      openPositions: this.positions.length,
      totalTrades: this.tradeLog.length,
    };
  }
}
