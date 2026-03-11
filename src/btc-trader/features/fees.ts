/**
 * Polymarket crypto market fee calculations.
 *
 * Per Polymarket docs: fee = C * p * feeRate * (p * (1 - p))^exponent
 * For crypto 5-min markets: feeRate = 0.25, exponent = 2
 * Peak effective rate is ~1.56% at price 0.50, declining to near 0% at extremes.
 */

const FEE_RATE = 0.25;
const FEE_EXPONENT = 2;

export function takerFeeRate(price: number): number {
  const p = Math.max(0.001, Math.min(0.999, price));
  return FEE_RATE * Math.pow(p * (1 - p), FEE_EXPONENT);
}

export function takerFee(price: number, size: number): number {
  return size * price * takerFeeRate(price);
}

export function effectiveBuyPrice(askPrice: number): number {
  return askPrice + takerFeeRate(askPrice) * askPrice;
}

export function effectiveSellPrice(bidPrice: number): number {
  return bidPrice - takerFeeRate(bidPrice) * bidPrice;
}

export function expectedPnl(
  entryPrice: number,
  probWin: number,
  size: number
): number {
  const entryFee = takerFee(entryPrice, size);
  const winPayout = size * 1.0;
  const costBasis = entryPrice * size + entryFee;
  return probWin * winPayout - costBasis;
}

export function minEdgeRequired(price: number): number {
  const fee = takerFeeRate(price);
  return fee / (1 - price) + 0.002; // fee + 0.2% buffer
}

export function isPositiveEV(
  marketPrice: number,
  modelProb: number,
  _side: 'up' | 'down'
): boolean {
  const price = marketPrice;
  const fee = takerFeeRate(price);
  const breakeven = price + fee * price;
  return modelProb > breakeven;
}
