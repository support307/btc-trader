import { Strategy, abstain } from './strategy-interface';
import { FeatureVector, StrategyDecision, MarketWindow, Direction } from '../types';
import { isPositiveEV } from '../features/fees';
import { AIPrediction } from '../data/news-feed';

/**
 * Ensemble V5 -- "Inverse Cramer"
 *
 * Asks Grok to roleplay as Jim Cramer -- emotional, momentum-chasing,
 * FOMO-driven, panic-selling. Then does the EXACT OPPOSITE.
 *
 * The thesis: Cramer-style retail sentiment is a reliable contrarian
 * indicator. When retail panics on a dip, the dip is likely over (buy UP).
 * When retail FOMOs on a pump, the pump is likely exhausted (buy DOWN).
 *
 * Guard rails prevent bad entries (cheap tokens, positive EV, min confidence).
 * Higher Cramer confidence = stronger contrarian signal = bigger bet.
 */
export class EnsembleV5Strategy implements Strategy {
  readonly name = 'ensemble-v5';

  private maxMarketPrice: number;
  private minConfidence: number;
  private kellyFraction = 0.25;

  private lastPrediction: AIPrediction | null = null;

  constructor(maxTokenPrice = 0.55, minConf = 0.60) {
    this.maxMarketPrice = maxTokenPrice;
    this.minConfidence = minConf;
  }

  setPrediction(prediction: AIPrediction): void {
    this.lastPrediction = prediction;
  }

  decide(features: FeatureVector, _window: MarketWindow): StrategyDecision {
    const prediction = this.lastPrediction;
    this.lastPrediction = null;

    if (!prediction) {
      return abstain(this.name, 'No Cramer prediction available (Grok call may have failed)');
    }

    if (prediction.direction === 'skip') {
      return abstain(this.name, `Cramer unavailable: ${prediction.reasoning}`);
    }

    if (prediction.confidence < this.minConfidence) {
      return abstain(this.name,
        `Cramer not confident enough: ${(prediction.confidence * 100).toFixed(0)}% (need ${(this.minConfidence * 100).toFixed(0)}%). ${prediction.reasoning}`
      );
    }

    const direction: Direction = prediction.direction;
    const confidence = prediction.confidence;
    const marketPrice = direction === 'up' ? features.impliedProbUp : features.impliedProbDown;

    if (marketPrice > this.maxMarketPrice) {
      return abstain(this.name,
        `Token too expensive: $${marketPrice.toFixed(3)} > $${this.maxMarketPrice.toFixed(2)}. ${prediction.reasoning}`
      );
    }

    if (!isPositiveEV(marketPrice, confidence, direction)) {
      return abstain(this.name,
        `Negative EV: conf ${(confidence * 100).toFixed(0)}% vs token $${marketPrice.toFixed(3)}. ${prediction.reasoning}`
      );
    }

    const edge = confidence - marketPrice;
    const odds = (1 - marketPrice) / marketPrice;
    const kellySize = Math.max(0, (edge * odds)) * this.kellyFraction;

    return {
      direction,
      confidence,
      strategy: this.name,
      reasoning: `Inverse Cramer: ${direction} ${(confidence * 100).toFixed(0)}% conf. ` +
        `Token: $${marketPrice.toFixed(3)} (${(1 / marketPrice).toFixed(1)}x payout). ` +
        `Kelly: ${kellySize.toFixed(3)}. ${prediction.reasoning}`,
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
}
