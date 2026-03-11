import { ExecutionAdapter } from './execution-adapter';
import { TradeOrder, TradeResult } from '../types';
import { btcConfig } from '../config';
import { logger } from '../clock/logger';

/**
 * Alpaca Crypto execution adapter.
 *
 * Uses Alpaca's crypto trading API to buy/sell BTC/USD.
 * Maps Polymarket "up/down" decisions to spot BTC trades:
 * - "up" prediction -> buy BTC
 * - "down" prediction -> sell BTC (if holding) or skip
 */
export class AlpacaCryptoExecAdapter implements ExecutionAdapter {
  readonly name = 'alpaca-crypto';

  private baseUrl: string;
  private headers: Record<string, string>;

  constructor() {
    this.baseUrl = btcConfig.alpaca.baseUrl;
    this.headers = {
      'APCA-API-KEY-ID': btcConfig.alpaca.apiKey,
      'APCA-API-SECRET-KEY': btcConfig.alpaca.apiSecret,
      'Content-Type': 'application/json',
    };
  }

  async isAvailable(): Promise<boolean> {
    if (!btcConfig.alpaca.apiKey || !btcConfig.alpaca.apiSecret) {
      logger.warn('Alpaca API keys not configured');
      return false;
    }
    try {
      const res = await fetch(`${this.baseUrl}/v2/account`, {
        headers: this.headers,
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async placeOrder(order: TradeOrder): Promise<TradeResult> {
    // Map Polymarket direction to BTC spot trade
    // Budget is in USD, we buy notional amount of BTC
    const notionalUsd = order.price * order.size;

    if (order.direction === 'down') {
      // For "down" predictions on Alpaca, we'd need to short BTC
      // which may not be available. Log and simulate.
      logger.info(
        `[ALPACA] Down prediction — would short $${notionalUsd.toFixed(2)} BTC. ` +
        `Skipping (short crypto not always available).`
      );
      return {
        order,
        filled: false,
        fillPrice: 0,
        fillSize: 0,
        fee: 0,
        pnl: 0,
      };
    }

    try {
      const body = {
        symbol: 'BTC/USD',
        notional: notionalUsd.toFixed(2),
        side: 'buy',
        type: 'market',
        time_in_force: 'gtc',
      };

      logger.info(`[ALPACA] Buying $${notionalUsd.toFixed(2)} BTC/USD`);

      const res = await fetch(`${this.baseUrl}/v2/orders`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errBody = await res.text();
        logger.error(`[ALPACA] Order failed ${res.status}: ${errBody}`);
        return this.failedResult(order);
      }

      const data = await res.json() as any;
      logger.info(`[ALPACA] Order placed: ${data.id} status=${data.status}`);

      // Wait for fill
      const filled = await this.waitForFill(data.id, 10_000);

      return {
        order,
        filled: !!filled,
        fillPrice: filled ? parseFloat(filled.filled_avg_price || '0') : 0,
        fillSize: filled ? parseFloat(filled.filled_qty || '0') : 0,
        fee: 0, // Alpaca includes fees in fill price
        pnl: 0,
      };
    } catch (err: any) {
      logger.error(`[ALPACA] Order error: ${err.message}`);
      return this.failedResult(order);
    }
  }

  async scheduleSellAfterWindow(windowEndMs: number): Promise<void> {
    const delayMs = windowEndMs - Date.now() + 5000; // 5s after window end
    if (delayMs > 0) {
      setTimeout(async () => {
        await this.closeAllBtcPositions();
      }, delayMs);
    }
  }

  async closeAllBtcPositions(): Promise<void> {
    try {
      const res = await fetch(`${this.baseUrl}/v2/positions/BTC%2FUSD`, {
        method: 'DELETE',
        headers: this.headers,
      });
      if (res.ok) {
        logger.info('[ALPACA] Closed BTC position');
      } else if (res.status === 404) {
        logger.debug('[ALPACA] No BTC position to close');
      } else {
        logger.warn(`[ALPACA] Close position returned ${res.status}`);
      }
    } catch (err: any) {
      logger.error(`[ALPACA] Close position error: ${err.message}`);
    }
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/v2/orders/${orderId}`, {
        method: 'DELETE',
        headers: this.headers,
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async getBalance(): Promise<{ available: number; currency: string }> {
    try {
      const res = await fetch(`${this.baseUrl}/v2/account`, {
        headers: this.headers,
      });
      const data = await res.json() as any;
      return {
        available: parseFloat(data.buying_power || '0'),
        currency: 'USD',
      };
    } catch {
      return { available: 0, currency: 'USD' };
    }
  }

  async getOpenPositions() {
    try {
      const res = await fetch(`${this.baseUrl}/v2/positions`, {
        headers: this.headers,
      });
      const positions = await res.json() as any[];
      return positions
        .filter((p: any) => p.symbol === 'BTC/USD' || p.symbol === 'BTCUSD')
        .map((p: any) => ({
          tokenId: p.symbol,
          side: p.side,
          size: parseFloat(p.qty),
          avgPrice: parseFloat(p.avg_entry_price),
        }));
    } catch {
      return [];
    }
  }

  private async waitForFill(orderId: string, timeoutMs: number): Promise<any | null> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const res = await fetch(`${this.baseUrl}/v2/orders/${orderId}`, {
          headers: this.headers,
        });
        const data = await res.json() as any;
        if (data.status === 'filled') return data;
        if (data.status === 'cancelled' || data.status === 'rejected') return null;
      } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    return null;
  }

  private failedResult(order: TradeOrder): TradeResult {
    return {
      order,
      filled: false,
      fillPrice: 0,
      fillSize: 0,
      fee: 0,
      pnl: 0,
    };
  }
}
