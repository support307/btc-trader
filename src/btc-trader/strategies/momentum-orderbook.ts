import { Strategy, abstain } from './strategy-interface';
import { FeatureVector, StrategyDecision, MarketWindow } from '../types';
import { isPositiveEV } from '../features/fees';

/**
 * Momentum + Orderbook Strategy
 *
 * Combines short-term BTC price momentum with Polymarket orderbook imbalance.
 * Trades 1-3 minutes into the window when early momentum signal is available.
 *
 * Uses a weighted logistic-style scoring model:
 * - BTC 1m return direction and magnitude
 * - BTC 5m momentum trend
 * - Volatility regime (high vol = smaller size)
 * - Orderbook depth imbalance (directional pressure)
 */
export class MomentumOrderbookStrategy implements Strategy {
  readonly name = 'momentum-orderbook';

  private minSecondsIntoWindow = 45;
  private maxSecondsIntoWindow = 200;
  private minConfidence = 0.52;

  private weights = {
    return1m: 0.30,
    return5m: 0.15,
    momentum: 0.15,
    bookImbalance: 0.25,
    impliedProb: 0.15,
  };

  decide(features: FeatureVector, window: MarketWindow): StrategyDecision {
    if (features.secondsIntoWindow < this.minSecondsIntoWindow) {
      return abstain(this.name, `Too early: ${features.secondsIntoWindow}s into window`);
    }
    if (features.secondsIntoWindow > this.maxSecondsIntoWindow) {
      return abstain(this.name, `Too late: ${features.secondsIntoWindow}s into window`);
    }

    // Normalize signals to [-1, 1] range
    const return1mSignal = this.sigmoid(features.btcReturn1m * 10000); // scale to basis points
    const return5mSignal = this.sigmoid(features.btcReturn5m * 5000);
    const momentumSignal = features.btcMomentum; // already -1 to 1

    // Orderbook imbalance for Up token: positive = more buy pressure = bullish
    const bookSignal = features.bookDepthImbalanceUp;

    // Market implied prob deviation from 0.5 (how much the market already knows)
    const impliedSignal = (features.impliedProbUp - 0.5) * 2;

    const rawScore =
      this.weights.return1m * return1mSignal +
      this.weights.return5m * return5mSignal +
      this.weights.momentum * momentumSignal +
      this.weights.bookImbalance * bookSignal +
      this.weights.impliedProb * impliedSignal;

    const direction = rawScore > 0 ? 'up' as const : 'down' as const;
    const absScore = Math.abs(rawScore);

    // Convert score to confidence: scales more aggressively at lower scores
    const confidence = 0.5 + 0.45 * this.sigmoid(absScore * 6 - 1);

    if (confidence < this.minConfidence) {
      return abstain(this.name, `Low confidence: ${confidence.toFixed(3)}, score: ${rawScore.toFixed(4)}`);
    }

    // Reduce confidence in high volatility regimes
    const volPenalty = Math.min(features.btcVolatility5m * 50, 0.15);
    const adjustedConfidence = confidence - volPenalty;

    if (adjustedConfidence < this.minConfidence) {
      return abstain(this.name, `Vol-adjusted confidence too low: ${adjustedConfidence.toFixed(3)}`);
    }

    const marketPrice = direction === 'up' ? features.impliedProbUp : features.impliedProbDown;

    // EV check: our model confidence should exceed the market price by enough to cover fees
    // When market data is approximate (backtest), use a looser threshold
    if (marketPrice > 0.01 && !isPositiveEV(marketPrice, adjustedConfidence, direction)) {
      return abstain(this.name, `Negative EV: model ${adjustedConfidence.toFixed(3)} vs market ${marketPrice.toFixed(3)}`);
    }

    return {
      direction,
      confidence: adjustedConfidence,
      strategy: this.name,
      reasoning: `Score ${rawScore.toFixed(4)} (1m:${return1mSignal.toFixed(2)}, 5m:${return5mSignal.toFixed(2)}, ` +
        `mom:${momentumSignal.toFixed(2)}, book:${bookSignal.toFixed(2)}). ` +
        `Confidence ${adjustedConfidence.toFixed(3)} (vol penalty ${volPenalty.toFixed(3)})`,
      features: {
        btcReturn1m: features.btcReturn1m,
        btcReturn5m: features.btcReturn5m,
        btcMomentum: features.btcMomentum,
        bookDepthImbalanceUp: features.bookDepthImbalanceUp,
      },
    };
  }

  private sigmoid(x: number): number {
    return 2 / (1 + Math.exp(-x)) - 1;
  }
}
