import { Strategy, abstain } from './strategy-interface';
import { FeatureVector, StrategyDecision, MarketWindow, Direction } from '../types';
import { isPositiveEV } from '../features/fees';

/**
 * Ensemble V2 -- "Late-Window Sniper"
 *
 * Designed after analysing 171 windows of v1 data showing 0 wins, 2 losses.
 * Key changes from v1:
 *   - Only buys cheap tokens (< $0.45) for 2.2x+ payout on wins
 *   - Requires minimum 0.03% BTC move to filter noise
 *   - Requires 2+ independent signals agreeing (no single-voter trades)
 *   - No sentiment -- useless on 5-minute timeframe
 *   - Focuses on late-window entries where repricing lag = real edge
 *   - Proportional Kelly sizing (10-50% of bankroll) instead of fixed $2
 */
export class EnsembleV2Strategy implements Strategy {
  readonly name = 'ensemble-v2';

  private maxMarketPrice = 0.45;
  private minEnsembleConfidence = 0.65;
  private minBtcMove = 0.0003;       // 0.03% minimum
  private minCandlesRequired = 2;
  private kellyFraction = 0.25;

  decide(features: FeatureVector, _window: MarketWindow): StrategyDecision {
    const absMove1m = Math.abs(features.btcReturn1m);
    const absMove5m = Math.abs(features.btcReturn5m);
    const bestMove = Math.max(absMove1m, absMove5m);

    if (bestMove < this.minBtcMove) {
      return abstain(this.name, `BTC move too small: ${(bestMove * 100).toFixed(4)}% (need ${(this.minBtcMove * 100).toFixed(3)}%)`);
    }

    const signals = this.collectSignals(features);

    if (signals.length === 0) {
      return abstain(this.name, 'No signals fired');
    }

    const upVotes = signals.filter(s => s.direction === 'up');
    const downVotes = signals.filter(s => s.direction === 'down');

    const upCount = upVotes.length;
    const downCount = downVotes.length;

    if (upCount < 2 && downCount < 2) {
      const sole = signals[0];
      return abstain(this.name, `Only 1 signal: ${sole.name} ${sole.direction} (${sole.confidence.toFixed(3)}). Need 2+ agreeing.`);
    }

    const direction: Direction = upCount >= downCount ? 'up' : 'down';
    const agreeing = direction === 'up' ? upVotes : downVotes;

    const avgConfidence = agreeing.reduce((sum, s) => sum + s.confidence, 0) / agreeing.length;
    const agreement = agreeing.length / signals.length;
    const confidence = avgConfidence * (0.75 + 0.25 * agreement);

    if (confidence < this.minEnsembleConfidence) {
      return abstain(this.name,
        `Low confidence: ${confidence.toFixed(3)} (avg=${avgConfidence.toFixed(3)}, agreement=${(agreement * 100).toFixed(0)}%)`
      );
    }

    const marketPrice = direction === 'up' ? features.impliedProbUp : features.impliedProbDown;

    if (marketPrice > this.maxMarketPrice) {
      return abstain(this.name, `Token too expensive: $${marketPrice.toFixed(3)} (max $${this.maxMarketPrice})`);
    }

    if (!isPositiveEV(marketPrice, confidence, direction)) {
      return abstain(this.name, `Negative EV: conf ${confidence.toFixed(3)} vs price ${marketPrice.toFixed(3)}`);
    }

    const edge = confidence - marketPrice;
    const odds = (1 - marketPrice) / marketPrice;
    const kellySize = Math.max(0, (edge * odds)) * this.kellyFraction;

    const voters = agreeing.map(s => `${s.name}:${s.confidence.toFixed(2)}`).join(', ');

    return {
      direction,
      confidence,
      strategy: this.name,
      reasoning: `V2 Sniper: ${direction} ${confidence.toFixed(3)} conf. ` +
        `Signals: [${voters}]. ${agreeing.length}/${signals.length} agree. ` +
        `Token: $${marketPrice.toFixed(3)}. Kelly: ${kellySize.toFixed(3)}`,
      suggestedSize: kellySize,
      features: {
        btcReturn1m: features.btcReturn1m,
        btcReturn5m: features.btcReturn5m,
        impliedProbUp: features.impliedProbUp,
        impliedProbDown: features.impliedProbDown,
        btcVolatility5m: features.btcVolatility5m,
        secondsIntoWindow: features.secondsIntoWindow,
      },
    };
  }

  /**
   * Collect independent directional signals. Each signal is a simple
   * yes/no check with a confidence score. We need 2+ to agree.
   */
  private collectSignals(f: FeatureVector): Signal[] {
    const signals: Signal[] = [];

    // Signal 1: Close-snipe (late window, BTC moved, market lagging)
    signals.push(...this.closeSnipeSignal(f));

    // Signal 2: Price momentum (BTC return direction)
    signals.push(...this.momentumSignal(f));

    // Signal 3: Orderbook pressure (depth imbalance)
    signals.push(...this.orderbookSignal(f));

    // Signal 4: Market-price divergence (market price disagrees with BTC direction)
    signals.push(...this.divergenceSignal(f));

    return signals;
  }

  /**
   * Close-snipe: 15-200s remaining, BTC moved, cheap side available.
   * This is the primary edge -- exploiting slow Polymarket repricing.
   */
  private closeSnipeSignal(f: FeatureVector): Signal[] {
    const remaining = 300 - f.secondsIntoWindow;
    if (remaining > 200 || remaining < 15) return [];

    const ret = f.btcReturn5m !== 0 ? f.btcReturn5m : f.btcReturn1m;
    const absMove = Math.abs(ret);
    if (absMove < 0.00005) return []; // 0.005% minimum for this signal

    const direction: Direction = ret > 0 ? 'up' : 'down';
    const moveFactor = Math.min(absMove / 0.001, 1.0);
    const timeFactor = 1 - (remaining - 15) / (200 - 15);
    const confidence = 0.55 + 0.30 * moveFactor * 0.6 + 0.30 * timeFactor * 0.4;

    if (confidence < 0.58) return [];

    return [{ name: 'close-snipe', direction, confidence }];
  }

  /**
   * Momentum: BTC has moved meaningfully in a clear direction.
   * Uses both 1m and 5m returns for confirmation.
   */
  private momentumSignal(f: FeatureVector): Signal[] {
    const ret1m = f.btcReturn1m;
    const ret5m = f.btcReturn5m;

    if (Math.abs(ret1m) < this.minBtcMove) return [];

    const direction: Direction = ret1m > 0 ? 'up' : 'down';

    const sameDirection = (ret1m > 0 && ret5m > 0) || (ret1m < 0 && ret5m < 0);
    const magnitude = Math.min(Math.abs(ret1m) / 0.001, 1.0);

    let confidence = 0.52 + 0.20 * magnitude;
    if (sameDirection && Math.abs(ret5m) > this.minBtcMove) {
      confidence += 0.08;
    }

    // Penalize when volatility data is unavailable
    if (f.btcVolatility5m === 0) {
      confidence -= 0.05;
    }

    confidence = Math.min(confidence, 0.80);

    if (confidence < 0.58) return [];

    return [{ name: 'momentum', direction, confidence }];
  }

  /**
   * Orderbook: depth imbalance on Polymarket suggests directional pressure.
   * Only fires when imbalance is significant.
   */
  private orderbookSignal(f: FeatureVector): Signal[] {
    const upImbalance = f.bookDepthImbalanceUp;
    const downImbalance = f.bookDepthImbalanceDown;

    const netImbalance = upImbalance - downImbalance;
    const absImbalance = Math.abs(netImbalance);

    if (absImbalance < 0.15) return [];

    const direction: Direction = netImbalance > 0 ? 'up' : 'down';
    const confidence = 0.55 + Math.min(absImbalance * 0.3, 0.20);

    if (confidence < 0.58) return [];

    return [{ name: 'orderbook', direction, confidence }];
  }

  /**
   * Divergence: BTC moved one way but the market token is still cheap.
   * Strongest signal -- the market hasn't caught up yet.
   */
  private divergenceSignal(f: FeatureVector): Signal[] {
    const ret = f.btcReturn1m !== 0 ? f.btcReturn1m : f.btcReturn5m;
    if (Math.abs(ret) < this.minBtcMove) return [];

    const btcDirection: Direction = ret > 0 ? 'up' : 'down';
    const marketPrice = btcDirection === 'up' ? f.impliedProbUp : f.impliedProbDown;

    // Market hasn't repriced: BTC moved but token is still cheap
    if (marketPrice > 0.40) return [];

    const cheapness = (0.40 - marketPrice) / 0.40;
    const moveMagnitude = Math.min(Math.abs(ret) / 0.001, 1.0);
    const confidence = 0.58 + 0.15 * cheapness + 0.10 * moveMagnitude;

    if (confidence < 0.60) return [];

    return [{ name: 'divergence', direction: btcDirection, confidence: Math.min(confidence, 0.85) }];
  }
}

interface Signal {
  name: string;
  direction: Direction;
  confidence: number;
}
