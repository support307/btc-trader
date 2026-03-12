import { Strategy, abstain } from './strategy-interface';
import { FeatureVector, StrategyDecision, MarketWindow, Direction } from '../types';
import { isPositiveEV } from '../features/fees';
import { AIPrediction } from '../data/news-feed';

/**
 * Ensemble V3 -- "AI Trader"
 *
 * Uses Grok AI as the primary directional signal. Every window, Grok
 * receives current BTC price, returns, volatility, Polymarket odds,
 * and X/Twitter context, then predicts UP/DOWN/SKIP with a confidence.
 *
 * Guard rails from V2 prevent bad entries (cheap tokens, positive EV,
 * min confidence). But the directional call is entirely AI-driven.
 *
 * Trades much more often than V2 because Grok has an opinion on most
 * windows where BTC has moved at all.
 */
export class EnsembleV3Strategy implements Strategy {
  readonly name = 'ensemble-v3';

  private maxMarketPrice: number;
  private minConfidence: number;
  private kellyFraction = 0.25;
  private maxKelly = 0.20;

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
      return abstain(this.name, 'No AI prediction available (Grok call may have failed)');
    }

    if (prediction.direction === 'skip') {
      return abstain(this.name, `AI says skip: ${prediction.reasoning}`);
    }

    if (prediction.confidence < this.minConfidence) {
      return abstain(this.name,
        `AI confidence too low: ${(prediction.confidence * 100).toFixed(0)}% (need ${(this.minConfidence * 100).toFixed(0)}%). ${prediction.reasoning}`
      );
    }

    const direction: Direction = prediction.direction;
    const confidence = prediction.confidence;
    const marketPrice = direction === 'up' ? features.impliedProbUp : features.impliedProbDown;

    // Block contrarian bets (market 70%+ the other way) unless AI is highly confident
    const isContrarian = marketPrice < 0.30;
    const requiredConf = isContrarian ? 0.70 : this.minConfidence;
    if (confidence < requiredConf) {
      return abstain(this.name,
        `Contrarian bet needs ${(requiredConf * 100).toFixed(0)}% conf, got ${(confidence * 100).toFixed(0)}%. Market: $${marketPrice.toFixed(3)}. ${prediction.reasoning}`
      );
    }

    if (marketPrice > this.maxMarketPrice) {
      return abstain(this.name,
        `Token too expensive: $${marketPrice.toFixed(3)} > $${this.maxMarketPrice.toFixed(2)}. AI said ${direction} ${(confidence * 100).toFixed(0)}%`
      );
    }

    if (!isPositiveEV(marketPrice, confidence, direction)) {
      return abstain(this.name,
        `Negative EV: AI conf ${(confidence * 100).toFixed(0)}% vs token $${marketPrice.toFixed(3)}. ${prediction.reasoning}`
      );
    }

    const edge = confidence - marketPrice;
    const odds = (1 - marketPrice) / marketPrice;
    const rawKelly = Math.max(0, (edge * odds)) * this.kellyFraction;

    // Reduce sizing late in window when market prices are more informative
    const timeDecay = features.secondsIntoWindow <= 150
      ? 1.0
      : Math.max(0.3, 1.0 - (features.secondsIntoWindow - 150) / 200);
    const kellySize = Math.min(rawKelly * timeDecay, this.maxKelly);

    return {
      direction,
      confidence,
      strategy: this.name,
      reasoning: `AI Trader: ${direction} ${(confidence * 100).toFixed(0)}% conf. ` +
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
