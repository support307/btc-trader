import { Strategy, abstain } from './strategy-interface';
import { FeatureVector, StrategyDecision, MarketWindow } from '../types';
import { isPositiveEV } from '../features/fees';

/**
 * Early Momentum Strategy
 *
 * Enters 60-120 seconds into the 5-minute window when the market hasn't
 * fully repriced yet. Uses short-term BTC momentum as the primary signal.
 * At this point the market is typically 0.45-0.60, so even moderate
 * confidence (55-65%) can be positive EV after fees.
 */
export class EarlyMomentumStrategy implements Strategy {
  readonly name = 'early-momentum';

  private minSecondsIntoWindow = 45;
  private maxSecondsIntoWindow = 180;
  private minAbsReturn = 0.00005; // 0.005% min move (~$3.5 at $70k)
  private minConfidence = 0.62;

  decide(features: FeatureVector, _window: MarketWindow): StrategyDecision {
    if (features.secondsIntoWindow < this.minSecondsIntoWindow) {
      return abstain(this.name, `Too early: ${features.secondsIntoWindow}s`);
    }
    if (features.secondsIntoWindow > this.maxSecondsIntoWindow) {
      return abstain(this.name, `Too late: ${features.secondsIntoWindow}s, market likely priced in`);
    }

    const ret = features.btcReturn1m !== 0 ? features.btcReturn1m : features.btcReturn5m;
    const absRet = Math.abs(ret);

    if (absRet < this.minAbsReturn) {
      return abstain(this.name, `No clear direction: ${(ret * 100).toFixed(4)}%`);
    }

    const direction = ret > 0 ? 'up' as const : 'down' as const;
    const marketPrice = direction === 'up' ? features.impliedProbUp : features.impliedProbDown;

    if (marketPrice > 0.75) {
      return abstain(this.name, `Market already priced in at ${marketPrice.toFixed(3)}`);
    }

    // Confidence from return magnitude, capped so we don't overtrade on noise
    const returnMagnitude = Math.min(absRet / 0.001, 1.0);
    let confidence = 0.52 + 0.20 * returnMagnitude;

    // Boost if market agrees (positive confirmation)
    const marketAgreement = direction === 'up'
      ? features.impliedProbUp - 0.5
      : features.impliedProbDown - 0.5;
    if (marketAgreement > 0) {
      confidence += Math.min(marketAgreement * 0.3, 0.08);
    }

    // Boost from sentiment if available
    if (features.sentimentScore !== 0) {
      const sentimentAligns =
        (direction === 'up' && features.sentimentScore > 0.1) ||
        (direction === 'down' && features.sentimentScore < -0.1);
      if (sentimentAligns) confidence += 0.04;
    }

    // Orderbook imbalance boost
    const bookImbalance = direction === 'up'
      ? features.bookDepthImbalanceUp
      : features.bookDepthImbalanceDown;
    if (bookImbalance > 0.1) {
      confidence += Math.min(bookImbalance * 0.1, 0.05);
    }

    confidence = Math.min(confidence, 0.85);

    if (confidence < this.minConfidence) {
      return abstain(this.name, `Low confidence: ${confidence.toFixed(3)}`);
    }

    if (!isPositiveEV(marketPrice, confidence, direction)) {
      return abstain(this.name, `Negative EV: model ${confidence.toFixed(3)} vs market ${marketPrice.toFixed(3)}`);
    }

    return {
      direction,
      confidence,
      strategy: this.name,
      reasoning: `BTC ${(ret * 100).toFixed(4)}% in ${features.secondsIntoWindow}s, ` +
        `market=${marketPrice.toFixed(3)}, conf=${confidence.toFixed(3)}, ` +
        `mktAgreement=${marketAgreement.toFixed(3)}`,
      features: {
        btcReturn1m: features.btcReturn1m,
        btcReturn5m: features.btcReturn5m,
        impliedProbUp: features.impliedProbUp,
        impliedProbDown: features.impliedProbDown,
      },
    };
  }
}
