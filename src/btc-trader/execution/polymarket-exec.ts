import { ExecutionAdapter } from './execution-adapter';
import { TradeOrder, TradeResult } from '../types';
import { btcConfig } from '../config';
import { logger } from '../clock/logger';
import { checkGeoblock } from '../data/gamma-client';
import { execSync } from 'child_process';

const POLYMARKET_MIN_SIZE = 5;

/**
 * Polymarket execution adapter using the CLI.
 *
 * The CLI reads wallet config from ~/.config/polymarket/config.json
 * (created by `polymarket wallet create`). No need to pass private key
 * via env -- the CLI handles authentication automatically.
 */
export class PolymarketExecAdapter implements ExecutionAdapter {
  readonly name = 'polymarket';
  private geoBlocked = false;

  async isAvailable(): Promise<boolean> {
    try {
      execSync('which polymarket', { stdio: 'pipe' });
    } catch {
      logger.error('Polymarket CLI not found in PATH');
      return false;
    }

    const geo = await checkGeoblock();
    if (geo.blocked) {
      this.geoBlocked = true;
      logger.warn(`Polymarket geo-blocked: country=${geo.country}. Ensure VPN is active (Brazil recommended).`);
      return false;
    }

    // Verify wallet is configured
    try {
      const output = execSync('polymarket wallet show', { timeout: 10_000, stdio: 'pipe' }).toString();
      if (!output.includes('Address:')) {
        logger.warn('Polymarket wallet not configured. Run: polymarket wallet create');
        return false;
      }
      logger.info(`[POLYMARKET] Wallet configured. ${output.split('\n')[0]}`);
    } catch {
      logger.warn('Polymarket wallet check failed');
      return false;
    }

    return true;
  }

  async placeOrder(order: TradeOrder): Promise<TradeResult> {
    if (this.geoBlocked) {
      return this.failedResult(order, 'Geo-blocked');
    }

    const price = Math.max(0.01, Math.min(0.99, parseFloat(order.price.toFixed(2))));
    const minSizeForDollar = Math.ceil(1.05 / price); // ensure > $1 total
    const size = Math.max(POLYMARKET_MIN_SIZE, minSizeForDollar, Math.round(order.size));

    try {
      const cmd = [
        'polymarket', 'clob', 'create-order',
        '--token', order.tokenId,
        '--side', order.side,
        '--price', price.toFixed(2),
        '--size', size.toString(),
        '-o', 'json',
      ].join(' ');

      const cost = (size * price).toFixed(2);
      logger.info(`[POLYMARKET] Placing order: ${order.direction} ${size} tokens @ $${price.toFixed(2)} ($${cost} total) on ${order.windowSlug}`);
      const output = execSync(cmd, { timeout: 30_000, stdio: 'pipe' }).toString();

      let result: any;
      try {
        result = JSON.parse(output);
      } catch {
        logger.info(`[POLYMARKET] CLI output: ${output.substring(0, 200)}`);
        result = { orderID: output.includes('order') ? 'unknown' : null };
      }

      const filled = !!result.orderID || !!result.order_id;
      if (filled) {
        logger.info(`[POLYMARKET] Order placed: ${result.orderID || result.order_id}`);
      } else {
        logger.warn(`[POLYMARKET] Order may not have been placed: ${JSON.stringify(result).substring(0, 200)}`);
      }

      return {
        order: { ...order, size },
        filled,
        fillPrice: price,
        fillSize: size,
        fee: 0,
        pnl: 0,
      };
    } catch (err: any) {
      const stderr = err.stderr?.toString?.() || '';
      const stdout = err.stdout?.toString?.() || '';
      const msg = stderr || stdout || err.message || 'Unknown error';
      logger.error(`[POLYMARKET] Order failed: ${msg.substring(0, 400)}`);
      return this.failedResult(order, msg);
    }
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    try {
      execSync(`polymarket clob cancel ${orderId}`, { timeout: 15_000 });
      return true;
    } catch (err: any) {
      logger.error(`[POLYMARKET] Cancel failed: ${err.message}`);
      return false;
    }
  }

  async getBalance(): Promise<{ available: number; currency: string }> {
    try {
      const output = execSync('polymarket clob balance --asset-type collateral', {
        timeout: 10_000,
      }).toString();
      // Parse "Balance: $X.XX" from table output
      const match = output.match(/\$?([\d.]+)/);
      const balance = match ? parseFloat(match[1]) : 0;
      return { available: balance, currency: 'USDC.e' };
    } catch {
      return { available: 0, currency: 'USDC.e' };
    }
  }

  async getOpenPositions() {
    try {
      const output = execSync('polymarket clob orders -o json', { timeout: 10_000 }).toString();
      const orders = JSON.parse(output);
      return (orders || []).map((o: any) => ({
        tokenId: o.asset_id || '',
        side: o.side || 'buy',
        size: parseFloat(o.size || '0'),
        avgPrice: parseFloat(o.price || '0'),
      }));
    } catch {
      return [];
    }
  }

  async countRedeemable(): Promise<number> {
    try {
      const proxyWallet = this.getProxyWallet();
      if (!proxyWallet) return 0;

      const output = execSync(
        `polymarket data positions ${proxyWallet} -o json`,
        { timeout: 15_000, stdio: 'pipe' }
      ).toString();
      const positions: any[] = JSON.parse(output);

      return positions.filter(
        (p: any) => p.redeemable === true && parseFloat(p.current_value || '0') > 0.01
      ).length;
    } catch {
      return 0;
    }
  }

  private getProxyWallet(): string | null {
    try {
      const output = execSync('polymarket wallet show', { timeout: 5_000, stdio: 'pipe' }).toString();
      const match = output.match(/Proxy wallet:\s+(0x[a-fA-F0-9]+)/);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  private failedResult(order: TradeOrder, reason: string): TradeResult {
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
