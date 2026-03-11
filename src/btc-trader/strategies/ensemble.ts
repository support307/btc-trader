import { Strategy, abstain } from './strategy-interface';
import { FeatureVector, StrategyDecision, MarketWindow, Direction } from '../types';
import { CloseSnipeStrategy } from './close-snipe';
import { MomentumOrderbookStrategy } from './momentum-orderbook';
import { ArbitrageStrategy } from './arbitrage';
import { SentimentGatedStrategy } from './sentiment-gated';
import { EarlyMomentumStrategy } from './early-momentum';
import { ValueFadeStrategy } from './value-fade';
import { isPositiveEV } from '../features/fees';

/**
 * Ensemble Strategy
 *
 * Runs all sub-strategies, aggregates their votes with confidence-weighted
 * scoring, and makes a final decision. Uses fractional Kelly criterion for sizing.
 */
export class EnsembleStrategy implements Strategy {
  readonly name = 'ensemble';

  private strategies: Strategy[];
  private weights: Record<string, number>;
  private minEnsembleConfidence = 0.50;
  private kellyFraction = 0.25;

  constructor() {
    this.strategies = [
      new EarlyMomentumStrategy(),
      new CloseSnipeStrategy(),
      new MomentumOrderbookStrategy(),
      new ValueFadeStrategy(),
      new ArbitrageStrategy(),
      new SentimentGatedStrategy(),
    ];
    this.weights = {
      'early-momentum': 0.30,
      'close-snipe': 0.40,
      'momentum-orderbook': 0.20,
      'value-fade': 0.00,
      'arbitrage': 0.00,
      'sentiment-gated': 0.10,
    };
  }

  decide(features: FeatureVector, window: MarketWindow): StrategyDecision {
    const subDecisions: StrategyDecision[] = [];
    for (const strategy of this.strategies) {
      subDecisions.push(strategy.decide(features, window));
    }

    // Arbitrage disabled: execution layer only supports single-side orders.
    // When dual-side execution is added, re-enable this shortcut.

    // Filter to non-abstaining strategies
    const active = subDecisions.filter((d) => d.direction !== 'abstain');

    if (active.length === 0) {
      return abstain(this.name, 'All sub-strategies abstained');
    }

    // Sentiment cannot trade solo -- require at least one data-driven strategy
    const SOFT_STRATEGIES = new Set(['sentiment-gated']);
    const hasHardData = active.some((d) => !SOFT_STRATEGIES.has(d.strategy));
    if (!hasHardData) {
      return abstain(this.name, 'Only sentiment voted -- need at least one data-driven strategy');
    }

    // Weighted vote aggregation
    let upScore = 0;
    let downScore = 0;
    let totalWeight = 0;

    for (const d of active) {
      const w = this.weights[d.strategy] || 0.1;
      totalWeight += w;
      if (d.direction === 'up') {
        upScore += w * d.confidence;
      } else if (d.direction === 'down') {
        downScore += w * d.confidence;
      }
    }

    if (totalWeight === 0) {
      return abstain(this.name, 'Zero total weight');
    }

    const normalizedUp = upScore / totalWeight;
    const normalizedDown = downScore / totalWeight;

    const direction: Direction = normalizedUp > normalizedDown ? 'up' : 'down';
    const winningScore = Math.max(normalizedUp, normalizedDown);
    const losingScore = Math.min(normalizedUp, normalizedDown);

    // Ensemble confidence: weighted average of winning direction, penalized by disagreement
    const agreement = active.filter((d) => d.direction === direction).length / active.length;
    const confidence = winningScore * (0.7 + 0.3 * agreement);

    if (confidence < this.minEnsembleConfidence) {
      return abstain(
        this.name,
        `Low ensemble confidence: ${confidence.toFixed(3)} (up:${normalizedUp.toFixed(3)}, down:${normalizedDown.toFixed(3)}, ` +
        `agreement:${(agreement * 100).toFixed(0)}%)`
      );
    }

    const marketPrice = direction === 'up' ? features.impliedProbUp : features.impliedProbDown;

    if (!isPositiveEV(marketPrice, confidence, direction)) {
      return abstain(this.name, `Negative EV: ensemble ${confidence.toFixed(3)} vs market ${marketPrice.toFixed(3)}`);
    }

    if (marketPrice > 0.75) {
      return abstain(this.name, `Market price too high (${marketPrice.toFixed(3)}), payout too small for risk`);
    }

    // Kelly criterion for position sizing (capped)
    const edge = confidence - marketPrice;
    const odds = (1 - marketPrice) / marketPrice;
    const kellySize = Math.max(0, (edge * odds) / 1) * this.kellyFraction;

    const voters = active.map((d) => `${d.strategy}:${d.direction}(${d.confidence.toFixed(2)})`).join(', ');

    return {
      direction,
      confidence,
      strategy: this.name,
      reasoning: `Ensemble: ${direction} with ${confidence.toFixed(3)} confidence. ` +
        `Voters: [${voters}]. Agreement: ${(agreement * 100).toFixed(0)}%. ` +
        `Kelly fraction: ${kellySize.toFixed(3)}`,
      suggestedSize: kellySize,
      features: {
        impliedProbUp: features.impliedProbUp,
        impliedProbDown: features.impliedProbDown,
        btcReturn1m: features.btcReturn1m,
        btcReturn5m: features.btcReturn5m,
      },
    };
  }

  getSubStrategies(): Strategy[] {
    return this.strategies;
  }
}
