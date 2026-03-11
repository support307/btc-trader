import { Strategy, abstain } from './strategy-interface';
import { FeatureVector, StrategyDecision, MarketWindow } from '../types';
import { isPositiveEV } from '../features/fees';

/**
 * Sentiment-Gated Strategy
 *
 * Uses news/social sentiment as a trade filter and directional boost.
 * High event risk -> abstain (avoid trading into volatility storms).
 * Strong sentiment + price confirmation -> trade with boosted confidence.
 *
 * This strategy acts primarily as a gate/modifier, not standalone alpha.
 */
export class SentimentGatedStrategy implements Strategy {
  readonly name = 'sentiment-gated';

  private eventRiskThreshold = 0.7;
  private minSentimentMagnitude = 0.2;
  private minConfidence = 0.60;

  decide(features: FeatureVector, _window: MarketWindow): StrategyDecision {
    // Gate: abstain during high event risk periods
    if (features.eventRisk > this.eventRiskThreshold) {
      return abstain(
        this.name,
        `High event risk (${features.eventRisk.toFixed(2)}), abstaining`
      );
    }

    const sentMag = Math.abs(features.sentimentScore);
    if (sentMag < this.minSentimentMagnitude) {
      return abstain(
        this.name,
        `Weak sentiment signal (${features.sentimentScore.toFixed(2)})`
      );
    }

    const sentimentDirection = features.sentimentScore > 0 ? 'up' as const : 'down' as const;

    // Check if price momentum confirms sentiment
    const priceConfirms =
      (sentimentDirection === 'up' && features.btcReturn1m > 0) ||
      (sentimentDirection === 'down' && features.btcReturn1m < 0);

    if (!priceConfirms && sentMag < 0.5) {
      return abstain(
        this.name,
        `Sentiment ${sentimentDirection} but price disagrees, magnitude too low`
      );
    }

    // Confidence: base from sentiment + price confirmation bonus + time factor
    let confidence = 0.50 + sentMag * 0.25;
    if (priceConfirms) confidence += 0.10;

    // Momentum alignment bonus
    const momentumAligns =
      (sentimentDirection === 'up' && features.btcMomentum > 0.2) ||
      (sentimentDirection === 'down' && features.btcMomentum < -0.2);
    if (momentumAligns) confidence += 0.05;

    // Weekend/low-liquidity penalty
    if (features.isWeekend) confidence -= 0.03;

    if (confidence < this.minConfidence) {
      return abstain(this.name, `Confidence too low: ${confidence.toFixed(3)}`);
    }

    const marketPrice = sentimentDirection === 'up'
      ? features.impliedProbUp
      : features.impliedProbDown;

    if (!isPositiveEV(marketPrice, confidence, sentimentDirection)) {
      return abstain(this.name, `Negative EV at market price ${marketPrice.toFixed(3)}`);
    }

    return {
      direction: sentimentDirection,
      confidence,
      strategy: this.name,
      reasoning: `Sentiment ${features.sentimentScore.toFixed(2)} ${sentimentDirection}, ` +
        `price ${priceConfirms ? 'confirms' : 'diverges'}, ` +
        `momentum ${features.btcMomentum.toFixed(2)}, ` +
        `event risk ${features.eventRisk.toFixed(2)}`,
      features: {
        sentimentScore: features.sentimentScore,
        eventRisk: features.eventRisk,
        btcReturn1m: features.btcReturn1m,
        btcMomentum: features.btcMomentum,
      },
    };
  }
}
