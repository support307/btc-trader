import { FeatureVector, StrategyDecision, MarketWindow } from '../types';

export interface Strategy {
  readonly name: string;

  decide(features: FeatureVector, window: MarketWindow): StrategyDecision;
}

export function abstain(strategyName: string, reason: string): StrategyDecision {
  return {
    direction: 'abstain',
    confidence: 0,
    strategy: strategyName,
    reasoning: reason,
  };
}
