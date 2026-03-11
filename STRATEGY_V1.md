# STRATEGY_V1 -- Close-Snipe Dominant

**Version**: V1 (Edge Overhaul)
**Activated**: March 11, 2026
**Previous version**: Survival Mode (March 10, 2026)

---

## Summary

Exploit Polymarket's slow repricing of 5-minute BTC markets. The bot does not predict BTC direction -- it detects when BTC has already moved and Polymarket odds haven't caught up, then buys the likely winning side before the window closes.

Core thesis: market microstructure edge, not signal prediction.

---

## Ensemble Weights

| Strategy | Weight | Status |
|----------|--------|--------|
| close-snipe | **0.60** | Primary -- repricing lag in final seconds |
| early-momentum | 0.20 | Supporting -- catches early underpricing |
| momentum-orderbook | 0.15 | Supporting -- orderbook confirmation |
| sentiment-gated | 0.05 | Minimal -- event-risk veto only |
| value-fade | 0.00 | Disabled |
| arbitrage | 0.00 | Disabled |

Zero-weight strategies are excluded from agreement math to prevent false abstains.

## Sub-Strategy Confidence Thresholds

| Strategy | Min Confidence |
|----------|---------------|
| close-snipe | 0.64 |
| early-momentum | 0.62 |
| momentum-orderbook | 0.58 |
| sentiment-gated | 0.60 |

## Ensemble Parameters

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Min ensemble confidence | 0.50 | Weighted average must exceed this to trade |
| Max market price | 0.75 | Won't buy tokens >$0.75 -- payout too small for risk |
| Kelly fraction | 0.25 | Quarter-Kelly for conservative sizing |
| EV filter | Positive required | Every trade must beat Polymarket fees |

## Evaluation Checkpoints

```
[75, 150, 220, 260] seconds into 300s window
```

- 75s: first look, mostly early-momentum
- 150s: mid-window re-evaluation
- 220s: late-window, close-snipe becomes active
- **260s: final shot -- 40s remaining, strongest repricing lag window**

The 260s checkpoint was added in V1. Previous version stopped at 220s (80s remaining).

## Volatility Gate

| Parameter | Value |
|-----------|-------|
| Threshold | 3 basis points (0.0003) |
| Measurement | `priceFeed.getVolatility(300_000, 10_000)` -- 5-min window, 10s samples |
| Behavior | If vol < threshold, skip the entire window (no strategy evaluation, no orderbook fetch) |

Rationale: when BTC is flat, there is no repricing lag to exploit. Saves compute and prevents noise trades.

## Dynamic Sizing

| Parameter | Value |
|-----------|-------|
| `BTC_BUDGET_PERCENT` | 25 |
| `BTC_BUDGET_MAX` | $20 |
| Floor | ~$2.50 (Polymarket minimum: 5 tokens) |
| Kelly scaling | `suggestedSize / 0.25` capped at 1.0 |

**Formula**:
```
pctBudget = balance * 0.25
kellyScale = min(kelly_fraction / 0.25, 1.0)
rawBudget = pctBudget * kellyScale
tradeBudget = max($2.50, min(rawBudget, $20))
orderSize = tradeBudget / marketPrice
```

Example at $10 balance, kelly=0.20: `$10 * 0.25 * 0.80 = $2.00 -> floored to $2.50`
Example at $50 balance, kelly=0.25: `$50 * 0.25 * 1.00 = $12.50`

Previous version used fixed $2 per trade regardless of balance or confidence.

## Key Feature: windowReturn

Close-snipe's primary signal is `windowReturn` -- the true BTC return since this specific 5-minute window opened, computed via `priceChangeFromWindowStart()`.

Previous version used `btcReturn5m` (rolling 5-minute return), which could include price movement from the *previous* window. This was a measurement error that diluted signal quality.

## Trade-to-Window Attribution

Each trade is tracked in an `openTrades` array keyed by window epoch. Resolution matches against this array, not a single `currentWindow` slot.

Previous version had a bug where overlapping windows caused PnL to be attributed to the wrong trade.

---

## What Changed from Survival Mode (V0)

| Aspect | Survival Mode (V0) | Edge Overhaul (V1) |
|--------|--------------------|--------------------|
| Close-snipe weight | 0.40 | **0.60** |
| Early-momentum weight | 0.30 | 0.20 |
| Momentum-orderbook weight | 0.20 | 0.15 |
| Sentiment-gated weight | 0.10 | 0.05 |
| Eval checkpoints | [75, 150, 220] | [75, 150, **220, 260**] |
| Volatility gate | None | **3bps minimum** |
| Sizing | Fixed $2 | **25% of balance, Kelly-scaled** |
| Close-snipe signal | Rolling btcReturn5m | **True windowReturn** |
| Trade attribution | Single currentWindow | **Per-window openTrades array** |
| Zero-weight in ensemble | Counted in agreement | **Excluded** |

## Expected Behavior

- **Fewer trades**: volatility gate skips flat windows (majority of 5-min windows)
- **Higher conviction**: only trades when BTC has moved AND Polymarket is behind
- **Compounding growth**: dynamic sizing means wins grow the next bet size
- **Better late-window capture**: 260s checkpoint catches the strongest repricing lag
- **Correct performance tracking**: attribution fix means win/loss stats are reliable

## Metrics to Track for Comparison

When evaluating V1 against future versions, compare:

- **Win rate** (target: >55%)
- **Net PnL per day**
- **Trades per day** (expect: fewer than V0)
- **Average entry price** (lower = better edge capture)
- **Abstain rate** (higher is fine if win rate improves)
- **Profit factor** (gross wins / gross losses, target: >1.3)
- **Max drawdown** (consecutive losses in dollar terms)
- **Balance growth curve** (compounding effect of dynamic sizing)
