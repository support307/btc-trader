import { Strategy, abstain } from './strategy-interface';
import { FeatureVector, StrategyDecision, MarketWindow } from '../types';
import { isPositiveEV } from '../features/fees';

/**
 * Value Fade Strategy (Mean Reversion)
 *
 * When the Polymarket odds have moved heavily to one side (>= 0.72),
 * check whether the cheap side offers value. Markets often overreact
 * to small BTC moves in the first 1-2 minutes; if the move is tiny
 * or already reversing, the underdog side at 0.25-0.35 pays 3-4x.
 *
 * EV math: buy token at $0.28, need >28% win rate to break even.
 * If overreactions revert ~35% of the time, that's edge.
 */
export class ValueFadeStrategy implements Strategy {
  readonly name = 'value-fade';

  private minOverreactionThreshold = 0.72;
  private maxCheapSidePrice = 0.38;
  private minSecondsIntoWindow = 60;
  private maxSecondsIntoWindow = 240;
  private minConfidence = 0.35;

  decide(features: FeatureVector, _window: MarketWindow): StrategyDecision {
    if (features.secondsIntoWindow < this.minSecondsIntoWindow) {
      return abstain(this.name, `Too early: ${features.secondsIntoWindow}s`);
    }
    if (features.secondsIntoWindow > this.maxSecondsIntoWindow) {
      return abstain(this.name, `Too late: ${features.secondsIntoWindow}s`);
    }

    const upPrice = features.impliedProbUp;
    const downPrice = features.impliedProbDown;

    // Determine which side is overpriced
    const marketLeanUp = upPrice >= this.minOverreactionThreshold;
    const marketLeanDown = downPrice >= this.minOverreactionThreshold;

    if (!marketLeanUp && !marketLeanDown) {
      return abstain(this.name, `No overreaction: up=${upPrice.toFixed(3)}, down=${downPrice.toFixed(3)}`);
    }

    // The cheap side is the one we'd bet on (fading the market)
    const fadeDirection = marketLeanUp ? 'down' as const : 'up' as const;
    const cheapPrice = fadeDirection === 'down' ? downPrice : upPrice;
    const expensivePrice = fadeDirection === 'down' ? upPrice : downPrice;

    if (cheapPrice > this.maxCheapSidePrice) {
      return abstain(this.name, `Cheap side not cheap enough: ${cheapPrice.toFixed(3)}`);
    }

    // Signal 1: BTC return magnitude is small -- market overreacted to noise
    const absReturn = Math.abs(features.btcReturn1m);
    const smallMove = absReturn < 0.001; // < 0.1%

    // Signal 2: BTC is reversing from the market's implied direction
    const marketImpliedUp = marketLeanUp;
    const priceReversing =
      (marketImpliedUp && features.btcReturn1m < -0.00003) ||
      (!marketImpliedUp && features.btcReturn1m > 0.00003);

    if (!smallMove && !priceReversing) {
      return abstain(
        this.name,
        `Move too large (${(absReturn * 100).toFixed(4)}%) and not reversing`
      );
    }

    // Build confidence
    let confidence = 0.30;

    // Boost for very small moves (likely noise the market overreacted to)
    if (absReturn < 0.0003) confidence += 0.06; // < 0.03%
    if (absReturn < 0.0001) confidence += 0.04; // < 0.01%

    // Boost if price is actively reversing
    if (priceReversing) {
      const reversalMagnitude = Math.min(Math.abs(features.btcReturn1m) / 0.0005, 1.0);
      confidence += 0.05 + 0.05 * reversalMagnitude;
    }

    // Boost from orderbook: if the cheap side has more depth, market may be wrong
    const cheapBookImbalance = fadeDirection === 'down'
      ? features.bookDepthImbalanceDown
      : features.bookDepthImbalanceUp;
    if (cheapBookImbalance > 0.05) {
      confidence += Math.min(cheapBookImbalance * 0.15, 0.06);
    }

    // Penalize if expensive side has strong momentum confirming it
    const momentumAgainstFade =
      (fadeDirection === 'down' && features.btcMomentum > 0.3) ||
      (fadeDirection === 'up' && features.btcMomentum < -0.3);
    if (momentumAgainstFade) confidence -= 0.08;

    confidence = Math.max(0, Math.min(confidence, 0.55));

    if (confidence < this.minConfidence) {
      return abstain(this.name, `Low confidence: ${confidence.toFixed(3)}`);
    }

    if (!isPositiveEV(cheapPrice, confidence, fadeDirection)) {
      return abstain(
        this.name,
        `Negative EV: model ${confidence.toFixed(3)} vs cheap side ${cheapPrice.toFixed(3)}`
      );
    }

    return {
      direction: fadeDirection,
      confidence,
      strategy: this.name,
      reasoning: `Fade ${marketLeanUp ? 'UP' : 'DOWN'} overreaction: ` +
        `expensive=${expensivePrice.toFixed(3)}, cheap=${cheapPrice.toFixed(3)}, ` +
        `btcRet1m=${(features.btcReturn1m * 100).toFixed(4)}%, ` +
        `${priceReversing ? 'REVERSING' : 'small-move'}, ` +
        `conf=${confidence.toFixed(3)}`,
      features: {
        impliedProbUp: features.impliedProbUp,
        impliedProbDown: features.impliedProbDown,
        btcReturn1m: features.btcReturn1m,
        bookDepthImbalanceUp: features.bookDepthImbalanceUp,
        bookDepthImbalanceDown: features.bookDepthImbalanceDown,
      },
    };
  }
}
