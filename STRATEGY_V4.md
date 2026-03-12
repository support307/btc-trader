# Strategy V4: Microstructure Edge

**Version**: V4 (Microstructure Edge)
**Activated**: March 2026
**Previous versions**: V1 (Close-Snipe Ensemble), V2 (Late-Window Sniper), V3 (AI Trader)

---

## Philosophy

V1 traded too often on heuristic noise. V2 traded too rarely. V3 relied on a black-box AI with latency and cost overhead. V4 takes a fundamentally different approach rooted in **market microstructure research**: instead of lagging price returns or AI opinions, it reads **leading indicators** from the Binance BTC/USDT L2 order book.

The academic literature (Cont-Kukanov-Stoikov, Stoikov microprice, DeepLOB, and extensive LOB prediction work) is unambiguous: **Order Flow Imbalance (OFI)** -- the net pressure from aggressive orders consuming liquidity at the best bid/ask -- is the single strongest predictor of short-horizon price direction. V4 operationalizes this research.

---

## How It Works

### Data Sources

V4 subscribes to **two** Binance WebSocket streams (V1-V3 only used one):

1. `btcusdt@trade` -- individual trade stream with aggressor side (`m` field)
2. `btcusdt@depth@100ms` -- L2 order book incremental updates every 100ms

The L2 stream feeds a local order book maintained following Binance's official sync protocol (snapshot + delta sequence validation + re-snapshot on gap).

### The 6 Microstructure Signals

At each evaluation checkpoint, V4 computes 6 independent signals:

| # | Signal | Data Source | What It Detects | Threshold |
|---|--------|-------------|-----------------|-----------|
| 1 | **OFI** (Order Flow Imbalance) | L2 book deltas | Net buy/sell pressure from bid/ask queue changes | abs(OFI) > 0.15 |
| 2 | **TFI** (Trade Flow Imbalance) | Trade stream `m` field | Aggressive buyer vs seller volume | abs(TFI) > 0.10 |
| 3 | **Microprice Edge** | L2 top-of-book | Imbalance-weighted fair value diverging from mid | abs(edge) > 0.10 |
| 4 | **Depth Pressure** | L2 top 10 levels | Structural bid/ask asymmetry | abs(skew) > 0.12 |
| 5 | **Volume Surge** | Trade stream | Sudden trade intensity spike (>1.8x baseline) | surge > 1.8 |
| 6 | **VWAP Trend** | Trade stream | Price vs volume-weighted average since window start | abs(dev) > 0.005% |

### Signal Combination

- Requires **3+ of 6 signals agreeing** on direction
- Confidence = weighted average of agreeing signals
- **Spread regime modulation**:
  - Tight spread (< 1 bps): confidence boosted 8% (signals are reliable)
  - Wide spread (> 3 bps): confidence dampened 15% (noisy regime)
- Late-window bonus at 240s+ (more accumulated data)

### Guard Rails

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Max token price | $0.50 | Ensures 2.0x+ payout on wins |
| Min ensemble confidence | 0.62 | Higher bar than V1 (0.50) to compensate for more frequent evals |
| Positive EV | Required | Must beat Polymarket fees |
| Min balance | $2.50 | Don't trade with dust |
| Kelly fraction | 0.25 | Quarter-Kelly for conservative sizing |
| Min signals agreeing | 3 of 6 | Prevents single-signal noise trades |

### Evaluation Checkpoints

V4 evaluates more frequently than V1-V3 because microstructure evolves fast:

| Checkpoint | Seconds | Purpose |
|------------|---------|---------|
| 1 | 60s | Early read -- strong directional flow already? |
| 2 | 120s | Confirmation -- flow persisted or reversed? |
| 3 | 180s | Primary decision -- 3 min of data, most reliable |
| 4 | 240s | Late entry -- catching late moves |
| 5 | 270s | Final 30s -- only on very strong consensus |

### Sizing

Same proportional Kelly system as V2:
- Kelly fraction from signal confidence and token price
- Bet = `balance * lerp(10%, 50%, kelly_fraction)`
- Higher confidence = larger bet within the range
- Floor at Polymarket minimum (~$2.50), cap at 50% of balance

---

## V4 vs V1 vs V2 vs V3

| Dimension | V1 (Ensemble) | V2 (Sniper) | V3 (AI Trader) | V4 (Microstructure) |
|-----------|---------------|-------------|----------------|---------------------|
| Primary signal | 6 heuristic sub-strategies | 4 signal detectors | Grok AI prediction | 6 microstructure signals |
| Signal type | Lagging (returns) | Lagging (returns) | Black-box AI | Leading (order flow) |
| Data sources | Binance trades | Binance trades | Binance trades + Grok | Binance trades + L2 book |
| Trade frequency | ~43% of windows | ~5% of windows | ~20-40% of windows | ~15-30% of windows |
| Max token price | $0.75 | $0.45 | $0.55 | $0.50 |
| Min voters | 1 (any strategy) | 2 (must agree) | 1 (Grok alone) | 3 of 6 (must agree) |
| Min confidence | 0.50 | 0.65 | 0.60 | 0.62 |
| Eval checkpoints | 75, 150, 220 | 75, 150, 220, 260 | 75, 150, 220 | 60, 120, 180, 240, 270 |
| Sizing | Fixed $2 | 10-50% Kelly | 10-50% Kelly | 10-50% Kelly |
| Latency overhead | ~0ms | ~0ms | 2-4s (API) | ~0ms |
| Cost per eval | $0 | $0 | ~$0.003 | $0 |
| Academic basis | Weak | Weak | None | Strong (OFI/microprice) |

---

## Running V4

```bash
npm run btc:start:v4
```

Or via environment variable:

```bash
BTC_STRATEGY=v4 npm run btc:start
```

---

## Config

| Env Var | Default | Description |
|---------|---------|-------------|
| `BTC_STRATEGY` | `v1` | Set to `v4` for Microstructure Edge |
| `BTC_V4_DISCORD_WEBHOOK_URL` | falls back to V1 URL | Discord webhook for V4 notifications |
| `BTC_MAX_BET_FRACTION` | `0.50` | Max fraction of bankroll per trade |
| `BTC_MIN_BET_FRACTION` | `0.10` | Min fraction of bankroll per trade |
| `BTC_MIN_BALANCE` | `2.50` | Stop trading below this balance |

No API keys required beyond what V1 uses. V4 does not call any external AI APIs.

---

## Architecture

```
Binance Trade WS (btcusdt@trade)
    |
    +-> BinancePriceFeed (existing)
    |     - Price ticks, candles, returns
    |     - NEW: Aggressor-side tracking (m field)
    |     - NEW: Trade flow imbalance, volume surge, VWAP
    |
Binance Depth WS (btcusdt@depth@100ms)
    |
    +-> BinanceOrderBookFeed (NEW)
          - Local L2 book with sequence validation
          - OFI accumulator (30s/60s/300s rolling)
          - Microprice computation
          - Depth skew at top 10 levels
                |
                v
        MicrostructureFeatures (NEW)
          - Combines book + trade features
          - Spread regime classification
                |
                v
        EnsembleV4Strategy (NEW)
          - 6 signal detectors
          - 3+ agreement required
          - Spread-conditioned confidence
          - Kelly sizing + guard rails
                |
                v
        Polymarket execution (existing)
```

---

## Log Format

V4 logs show microstructure state and signal details:

```
Microstructure: OFI(30s/60s/300s)=0.45/0.32/0.18, TFI(30s/60s)=0.152/0.089, microprice=0.234, depth=0.156, volSurge=2.31, vwap=0.000082, spread=0.8bps(tight)
Decision: up (ensemble-v4, confidence: 0.712) -- V4 Micro: up 0.712 conf. 4/6 signals agree. [ofi:0.72, tfi:0.68, microprice:0.70, vwap:0.65]. Token: $0.380. Kelly: 0.289
```

---

## How the OFI Signal Works (Technical)

Per Cont-Kukanov-Stoikov, on each L2 update:

```
if new_best_bid_price > old_best_bid_price:
    ofi += new_best_bid_qty        (bid improved = buy pressure)
elif same price:
    ofi += (new_qty - old_qty)     (queue grew = buy pressure)
else:
    ofi -= old_best_bid_qty        (bid retreated = sell pressure)

// Mirror for ask side with inverted signs
```

Rolling OFI = sum of increments in window / average top-of-book depth.

The relationship OFI -> short-horizon price change is the most consistently documented result in market microstructure research, with slope inversely related to depth.

---

## Risks

- **Book desync**: If the L2 book loses sync (sequence gap), V4 disables trading until re-synced. This is a safety feature, not a bug.
- **Thin BTC book hours**: During low-volume periods (weekends, Asian night), microstructure signals may be noisier. The spread regime dampener handles this.
- **Regime changes**: Microstructure relationships can shift. Monitor win rate weekly. If sustained < 50%, recalibrate signal thresholds.
- **No on-chain signals**: V4 does not use mempool/on-chain data (yet). This is a future enhancement opportunity.

---

## Metrics to Track

| Metric | Target | How to Check |
|--------|--------|-------------|
| Win rate | >55% | state/btc-trading-state.json |
| Avg token price on entry | <$0.42 | Cycle log fillPrice |
| Trade frequency | 3-8/hour during active markets | Count cycle log entries |
| Book sync rate | >99% | Count "not synced" abstains in logs |
| Signal agreement avg | 3.5+/6 on traded windows | Parse reasoning from cycle log |
| Net P&L per day | Positive | todayStats.totalPnl |
| Spread regime distribution | >60% tight/normal | Parse from microstructure logs |
