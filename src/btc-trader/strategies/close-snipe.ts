import { Strategy, abstain } from './strategy-interface';
import { FeatureVector, StrategyDecision, MarketWindow } from '../types';
import { isPositiveEV, takerFeeRate } from '../features/fees';

/**
 * Close-Snipe Strategy
 *
 * Waits until the last 30-90 seconds of a 5-minute window. If BTC has moved
 * significantly away from the window start price, the outcome becomes highly
 * predictable. Buys the likely winning side if the market hasn't fully repriced.
 *
 * High win rate, small profit per trade.
 */
export class CloseSnipeStrategy implements Strategy {
  readonly name = 'close-snipe';

  private minSecondsRemaining = 20;
  private maxSecondsRemaining = 180;
  private minPriceMove = 0.00008;      // 0.008% BTC move (~$5.6 at $70k)
  private minConfidence = 0.64;

  decide(features: FeatureVector, window: MarketWindow): StrategyDecision {
    const secondsRemaining = 300 - features.secondsIntoWindow;

    if (secondsRemaining > this.maxSecondsRemaining) {
      return abstain(this.name, `Too early: ${secondsRemaining}s remaining`);
    }
    if (secondsRemaining < this.minSecondsRemaining) {
      return abstain(this.name, `Too late: ${secondsRemaining}s remaining, execution risk`);
    }

    const inWindowReturn = features.windowReturn !== 0
      ? features.windowReturn
      : (features.btcReturn5m !== 0 ? features.btcReturn5m : features.btcReturn1m);
    const absMove = Math.abs(inWindowReturn);

    if (absMove < this.minPriceMove) {
      return abstain(this.name, `Insufficient move: ${(absMove * 100).toFixed(4)}% (used ${features.btcReturn5m !== 0 ? '5m' : '1m'} return)`);
    }

    const direction = inWindowReturn > 0 ? 'up' as const : 'down' as const;

    // Confidence scales with how far BTC has moved and how close to window end
    const moveFactor = Math.min(absMove / 0.001, 1.0); // saturates at 0.1%
    const timeFactor = 1 - (secondsRemaining - this.minSecondsRemaining) /
      (this.maxSecondsRemaining - this.minSecondsRemaining);
    const confidence = 0.55 + 0.35 * moveFactor * 0.6 + 0.35 * timeFactor * 0.4;

    if (confidence < this.minConfidence) {
      return abstain(this.name, `Low confidence: ${confidence.toFixed(3)}`);
    }

    const marketPrice = direction === 'up' ? features.impliedProbUp : features.impliedProbDown;

    if (marketPrice > 0.98) {
      return abstain(this.name, `Market already priced in: ${marketPrice.toFixed(3)}`);
    }

    if (!isPositiveEV(marketPrice, confidence, direction)) {
      return abstain(this.name, `Negative EV after fees at price ${marketPrice.toFixed(3)}`);
    }

    return {
      direction,
      confidence,
      strategy: this.name,
      reasoning: `BTC moved ${(inWindowReturn * 100).toFixed(4)}% with ${secondsRemaining}s left. ` +
        `Market prices ${direction} at ${marketPrice.toFixed(3)}, model confidence ${confidence.toFixed(3)}`,
      features: {
        btcReturn5m: inWindowReturn,
        secondsIntoWindow: features.secondsIntoWindow,
        impliedProbUp: features.impliedProbUp,
        impliedProbDown: features.impliedProbDown,
      },
    };
  }
}
