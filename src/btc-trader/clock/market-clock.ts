import { MarketWindow } from '../types';
import { btcConfig } from '../config';
import { logger } from './logger';

const WINDOW_SECONDS = btcConfig.trading.windowSeconds;

export class MarketClock {
  getCurrentEpoch(): number {
    return Math.floor(Date.now() / 1000 / WINDOW_SECONDS) * WINDOW_SECONDS;
  }

  getNextEpoch(): number {
    return this.getCurrentEpoch() + WINDOW_SECONDS;
  }

  getSecondsIntoWindow(): number {
    return Math.floor(Date.now() / 1000) - this.getCurrentEpoch();
  }

  getSecondsUntilWindowEnd(): number {
    return WINDOW_SECONDS - this.getSecondsIntoWindow();
  }

  buildSlug(epoch: number): string {
    return `btc-updown-5m-${epoch}`;
  }

  async fetchCurrentWindow(): Promise<MarketWindow | null> {
    const epoch = this.getCurrentEpoch();
    return this.fetchWindowByEpoch(epoch);
  }

  async fetchWindowByEpoch(epoch: number): Promise<MarketWindow | null> {
    const slug = this.buildSlug(epoch);
    try {
      const url = `${btcConfig.polymarket.gammaBaseUrl}/markets?slug=${slug}`;
      const res = await fetch(url);
      if (!res.ok) {
        logger.warn(`Gamma API returned ${res.status} for slug ${slug}`);
        return null;
      }
      const data = await res.json() as any[];
      if (!data || data.length === 0) return null;

      const market = data[0];
      return this.parseMarket(market, epoch);
    } catch (err: any) {
      logger.error(`Failed to fetch market for epoch ${epoch}: ${err.message}`);
      return null;
    }
  }

  parseMarket(market: any, epoch: number): MarketWindow {
    const tokenIds = JSON.parse(market.clobTokenIds || '[]');
    const outcomes = JSON.parse(market.outcomes || '[]');
    const outcomePrices = JSON.parse(market.outcomePrices || '[]');

    let upTokenId = tokenIds[0] || '';
    let downTokenId = tokenIds[1] || '';

    const upIdx = outcomes.findIndex((o: string) => o.toLowerCase() === 'up');
    const downIdx = outcomes.findIndex((o: string) => o.toLowerCase() === 'down');
    if (upIdx >= 0 && downIdx >= 0) {
      upTokenId = tokenIds[upIdx];
      downTokenId = tokenIds[downIdx];
    }

    let outcome: 'up' | 'down' | undefined;
    const upPrice = parseFloat(outcomePrices[upIdx >= 0 ? upIdx : 0] || '0');
    const downPrice = parseFloat(outcomePrices[downIdx >= 0 ? downIdx : 1] || '0');

    // Market is resolved if formally closed, OR if window has ended and prices are extreme
    const windowEnded = Date.now() / 1000 > epoch + WINDOW_SECONDS;
    const pricesExtreme = upPrice > 0.95 || downPrice > 0.95;
    const effectivelyResolved = market.closed || (windowEnded && pricesExtreme);

    if (effectivelyResolved) {
      outcome = upPrice > downPrice ? 'up' : 'down';
    }

    return {
      slug: market.slug || this.buildSlug(epoch),
      epochStart: epoch,
      epochEnd: epoch + WINDOW_SECONDS,
      conditionId: market.conditionId || '',
      upTokenId,
      downTokenId,
      resolved: effectivelyResolved,
      outcome,
    };
  }

  epochsForDateRange(startTs: number, endTs: number): number[] {
    const epochs: number[] = [];
    let t = Math.ceil(startTs / WINDOW_SECONDS) * WINDOW_SECONDS;
    while (t < endTs) {
      epochs.push(t);
      t += WINDOW_SECONDS;
    }
    return epochs;
  }
}

export const marketClock = new MarketClock();
