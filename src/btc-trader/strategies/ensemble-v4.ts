import { Strategy, abstain } from './strategy-interface';
import { FeatureVector, StrategyDecision, MarketWindow, Direction } from '../types';
import { isPositiveEV } from '../features/fees';
import { MicrostructureState, SpreadRegime } from '../features/microstructure-features';

interface Signal {
  name: string;
  direction: Direction;
  confidence: number;
}

/**
 * Ensemble V4 -- "Microstructure Edge"
 *
 * Uses Binance L2 order book microstructure as the primary signal source.
 * Instead of lagging price returns (V1/V2) or AI opinion (V3), V4 reads
 * leading indicators: order flow imbalance, trade aggressor flow, microprice
 * pressure, depth asymmetry, volume surges, and VWAP trends.
 *
 * Academic basis: Cont–Kukanov–Stoikov (OFI), Stoikov (microprice),
 * and extensive LOB prediction literature showing these features are
 * the strongest short-horizon price direction predictors.
 *
 * Requires 3+ of 6 independent signals to agree on direction.
 * Spread regime modulates confidence (tight = boost, wide = dampen).
 */
export class EnsembleV4Strategy implements Strategy {
  readonly name = 'ensemble-v4';

  private maxMarketPrice = 0.50;
  private minEnsembleConfidence = 0.62;
  private kellyFraction = 0.25;

  private microState: MicrostructureState | null = null;

  setMicrostructureState(state: MicrostructureState): void {
    this.microState = state;
  }

  decide(features: FeatureVector, _window: MarketWindow): StrategyDecision {
    const micro = this.microState;
    this.microState = null;

    if (!micro || !micro.bookSynced) {
      return abstain(this.name, 'No microstructure data (L2 book not synced)');
    }

    const signals = this.collectSignals(features, micro);

    if (signals.length === 0) {
      return abstain(this.name, 'No microstructure signals fired');
    }

    const upVotes = signals.filter(s => s.direction === 'up');
    const downVotes = signals.filter(s => s.direction === 'down');

    const upCount = upVotes.length;
    const downCount = downVotes.length;

    if (upCount < 3 && downCount < 3) {
      const dirs = signals.map(s => `${s.name}:${s.direction}`).join(', ');
      return abstain(this.name, `Only ${Math.max(upCount, downCount)} signals agree (need 3). [${dirs}]`);
    }

    const direction: Direction = upCount >= downCount ? 'up' : 'down';
    const agreeing = direction === 'up' ? upVotes : downVotes;

    const avgConfidence = agreeing.reduce((sum, s) => sum + s.confidence, 0) / agreeing.length;
    const agreement = agreeing.length / signals.length;

    let confidence = avgConfidence * (0.70 + 0.30 * agreement);

    confidence = this.applySpreadRegimeModifier(confidence, micro.spreadRegime);

    // Late-window boost: more data = more reliable signals
    if (features.secondsIntoWindow >= 240) {
      confidence = Math.min(confidence * 1.05, 0.92);
    }

    if (confidence < this.minEnsembleConfidence) {
      return abstain(this.name,
        `Low confidence: ${confidence.toFixed(3)} (avg=${avgConfidence.toFixed(3)}, ` +
        `agreement=${(agreement * 100).toFixed(0)}%, spread=${micro.spreadRegime})`
      );
    }

    const marketPrice = direction === 'up' ? features.impliedProbUp : features.impliedProbDown;

    if (marketPrice > this.maxMarketPrice) {
      return abstain(this.name, `Token too expensive: $${marketPrice.toFixed(3)} > $${this.maxMarketPrice}`);
    }

    if (!isPositiveEV(marketPrice, confidence, direction)) {
      return abstain(this.name, `Negative EV: conf ${confidence.toFixed(3)} vs price ${marketPrice.toFixed(3)}`);
    }

    const edge = confidence - marketPrice;
    const odds = (1 - marketPrice) / marketPrice;
    const kellySize = Math.max(0, (edge * odds)) * this.kellyFraction;

    const voters = agreeing.map(s => `${s.name}:${s.confidence.toFixed(2)}`).join(', ');
    const allSignals = signals.map(s => `${s.name}:${s.direction}(${s.confidence.toFixed(2)})`).join(', ');

    return {
      direction,
      confidence,
      strategy: this.name,
      reasoning: `V4 Micro: ${direction} ${confidence.toFixed(3)} conf. ` +
        `${agreeing.length}/${signals.length} signals agree. [${voters}]. ` +
        `Token: $${marketPrice.toFixed(3)}. Kelly: ${kellySize.toFixed(3)}. ` +
        `Spread: ${micro.spreadBps.toFixed(1)}bps (${micro.spreadRegime}). ` +
        `All: [${allSignals}]`,
      suggestedSize: kellySize,
      features: {
        btcReturn1m: features.btcReturn1m,
        btcReturn5m: features.btcReturn5m,
        impliedProbUp: features.impliedProbUp,
        impliedProbDown: features.impliedProbDown,
        btcVolatility5m: features.btcVolatility5m,
        secondsIntoWindow: features.secondsIntoWindow,
        ofi60s: micro.ofi60s,
        tradeFlowImbalance30s: micro.tradeFlowImbalance30s,
        micropriceEdge: micro.micropriceEdge,
        depthSkew: micro.depthSkew,
        volumeSurge: micro.volumeSurge,
        vwapDeviation: micro.vwapDeviation,
        spreadBps: micro.spreadBps,
      },
    };
  }

  private applySpreadRegimeModifier(confidence: number, regime: SpreadRegime): number {
    switch (regime) {
      case 'tight': return Math.min(confidence * 1.08, 0.92);
      case 'wide': return confidence * 0.85;
      default: return confidence;
    }
  }

  private collectSignals(f: FeatureVector, micro: MicrostructureState): Signal[] {
    const signals: Signal[] = [];

    signals.push(...this.ofiSignal(micro));
    signals.push(...this.tradeFlowSignal(micro));
    signals.push(...this.micropriceSignal(micro));
    signals.push(...this.depthPressureSignal(micro));
    signals.push(...this.volumeSurgeSignal(micro));
    signals.push(...this.vwapTrendSignal(f, micro));

    return signals;
  }

  /**
   * Signal 1: OFI (Order Flow Imbalance)
   * Uses 60s OFI as primary, confirmed by 30s for responsiveness.
   * The strongest academic predictor of short-horizon price direction.
   */
  private ofiSignal(micro: MicrostructureState): Signal[] {
    const ofi = micro.ofi60s;
    const absOfi = Math.abs(ofi);

    if (absOfi < 0.15) return [];

    const direction: Direction = ofi > 0 ? 'up' : 'down';

    // Confirm with shorter window -- same direction strengthens signal
    const shortOfi = micro.ofi30s;
    const confirmed = (ofi > 0 && shortOfi > 0) || (ofi < 0 && shortOfi < 0);

    let confidence = 0.55 + Math.min(absOfi * 0.20, 0.25);
    if (confirmed) confidence += 0.05;
    confidence = Math.min(confidence, 0.85);

    if (confidence < 0.58) return [];

    return [{ name: 'ofi', direction, confidence }];
  }

  /**
   * Signal 2: Trade Flow Imbalance (TFI)
   * Net buyer vs seller aggressor volume. Binance `m` field gives direct aggressor side.
   */
  private tradeFlowSignal(micro: MicrostructureState): Signal[] {
    const tfi30 = micro.tradeFlowImbalance30s;
    const tfi60 = micro.tradeFlowImbalance60s;
    const absTfi = Math.abs(tfi30);

    if (absTfi < 0.10) return [];

    const direction: Direction = tfi30 > 0 ? 'up' : 'down';

    const confirmed = (tfi30 > 0 && tfi60 > 0) || (tfi30 < 0 && tfi60 < 0);

    let confidence = 0.54 + Math.min(absTfi * 0.25, 0.25);
    if (confirmed && Math.abs(tfi60) > 0.08) confidence += 0.05;
    confidence = Math.min(confidence, 0.82);

    if (confidence < 0.58) return [];

    return [{ name: 'tfi', direction, confidence }];
  }

  /**
   * Signal 3: Microprice Edge
   * When microprice diverges from mid, the top-of-book imbalance is
   * signaling directional pressure. Persistent edge = conviction.
   */
  private micropriceSignal(micro: MicrostructureState): Signal[] {
    const edge = micro.micropriceEdge;
    const absEdge = Math.abs(edge);

    if (absEdge < 0.10) return [];

    const direction: Direction = edge > 0 ? 'up' : 'down';

    let confidence = 0.55 + Math.min(absEdge * 0.30, 0.25);
    confidence = Math.min(confidence, 0.82);

    if (confidence < 0.58) return [];

    return [{ name: 'microprice', direction, confidence }];
  }

  /**
   * Signal 4: Depth Pressure
   * Structural bid/ask asymmetry. Heavy bids = support = bullish.
   * More stable than OFI (changes slower), adds confirmation.
   */
  private depthPressureSignal(micro: MicrostructureState): Signal[] {
    const skew = micro.depthSkew;
    const absSkew = Math.abs(skew);

    if (absSkew < 0.12) return [];

    const direction: Direction = skew > 0 ? 'up' : 'down';

    let confidence = 0.54 + Math.min(absSkew * 0.25, 0.22);
    confidence = Math.min(confidence, 0.80);

    if (confidence < 0.58) return [];

    return [{ name: 'depth', direction, confidence }];
  }

  /**
   * Signal 5: Volume Surge
   * Sudden trade intensity spike (>1.8x baseline) indicates a directional
   * catalyst. Direction taken from concurrent trade flow.
   */
  private volumeSurgeSignal(micro: MicrostructureState): Signal[] {
    if (micro.volumeSurge < 1.8) return [];

    const tfi = micro.tradeFlowImbalance30s;
    if (Math.abs(tfi) < 0.05) return [];

    const direction: Direction = tfi > 0 ? 'up' : 'down';

    const surgeMag = Math.min((micro.volumeSurge - 1.0) / 3.0, 1.0);
    let confidence = 0.56 + 0.20 * surgeMag;
    confidence = Math.min(confidence, 0.82);

    if (confidence < 0.58) return [];

    return [{ name: 'vol-surge', direction, confidence }];
  }

  /**
   * Signal 6: VWAP Trend
   * Price above VWAP = buyers winning the window. Strongest when
   * the deviation is meaningful relative to the price.
   */
  private vwapTrendSignal(f: FeatureVector, micro: MicrostructureState): Signal[] {
    const dev = micro.vwapDeviation;
    const absDev = Math.abs(dev);

    if (absDev < 0.00005) return [];

    const direction: Direction = dev > 0 ? 'up' : 'down';

    const magnitude = Math.min(absDev / 0.001, 1.0);
    let confidence = 0.54 + 0.20 * magnitude;

    // Stronger signal later in the window (more volume behind the VWAP)
    if (f.secondsIntoWindow > 180) confidence += 0.03;

    confidence = Math.min(confidence, 0.80);

    if (confidence < 0.58) return [];

    return [{ name: 'vwap', direction, confidence }];
  }
}
