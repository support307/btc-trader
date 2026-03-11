import { Strategy, abstain } from './strategy-interface';
import { FeatureVector, StrategyDecision, MarketWindow } from '../types';
import { takerFeeRate } from '../features/fees';

/**
 * Arbitrage Strategy
 *
 * Scans for opportunities where buying both Up and Down tokens costs less than $1
 * after fees. Since exactly one outcome pays $1 at resolution, this locks in a
 * risk-free profit (minus execution risk from partial fills).
 *
 * In practice these opportunities are rare and fleeting on liquid markets.
 */
export class ArbitrageStrategy implements Strategy {
  readonly name = 'arbitrage';

  private minSpread = 0.005; // min 0.5% profit after fees

  decide(features: FeatureVector, _window: MarketWindow): StrategyDecision {
    const upAsk = features.impliedProbUp + features.bookBidAskSpreadUp / 2;
    const downAsk = features.impliedProbDown + features.bookBidAskSpreadDown / 2;

    const upFee = takerFeeRate(upAsk) * upAsk;
    const downFee = takerFeeRate(downAsk) * downAsk;

    const totalCost = upAsk + downAsk + upFee + downFee;
    const profit = 1.0 - totalCost;

    if (profit < this.minSpread) {
      return abstain(
        this.name,
        `No arb: cost ${totalCost.toFixed(4)} (up ${upAsk.toFixed(3)} + down ${downAsk.toFixed(3)} + fees ${(upFee + downFee).toFixed(4)})`
      );
    }

    // For arbitrage, direction doesn't matter (we buy both sides)
    // We signal "up" but the execution layer handles buying both
    return {
      direction: 'up',
      confidence: 0.99,
      strategy: this.name,
      reasoning: `Arbitrage found! Total cost ${totalCost.toFixed(4)}, profit ${profit.toFixed(4)} ` +
        `(${(profit * 100).toFixed(2)}%). Up ask: ${upAsk.toFixed(3)}, Down ask: ${downAsk.toFixed(3)}`,
      suggestedSize: Math.min(100 / profit, 500),
    };
  }
}
