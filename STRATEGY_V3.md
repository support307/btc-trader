# Strategy V3: AI Trader

**Version**: V3 (AI Trader)
**Activated**: March 11, 2026
**Previous versions**: V1 (Close-Snipe Ensemble), V2 (Late-Window Sniper)

---

## Philosophy

V1 traded too often on heuristic noise. V2 traded too rarely waiting for perfect microstructure setups. V3 takes a fundamentally different approach: **let Grok AI make the directional call** on every window, with market-structure guard rails preventing bad entries.

The AI receives real-time BTC price data, momentum, volatility, Polymarket odds, and X/Twitter context, then predicts UP/DOWN/SKIP with a confidence level. If confident enough and the token is cheap enough for good risk/reward, we trade.

---

## How It Works

### Every 5-Minute Window

At each evaluation checkpoint (75s, 150s, 220s, 260s), the bot:

1. Builds the feature vector (BTC price, returns, vol, orderbook, market odds)
2. Calls Grok with a purpose-built prompt including all market state + X/Twitter context
3. Grok returns: `{ direction: "up"|"down"|"skip", confidence: 0.0-1.0, reasoning: "..." }`
4. Guard rails check: token cheap enough? Positive EV? Confidence high enough?
5. If all pass: place the trade with Kelly-proportional sizing

### The Grok Prompt

Grok receives:
- Current BTC price
- 1-minute and 5-minute returns
- Window return (BTC move since this specific window opened)
- 5-minute volatility in basis points
- Polymarket UP and DOWN token prices (the market's current odds)
- Seconds remaining in the window
- Recent X/Twitter context (any breaking events)

Grok is instructed to:
- Follow short-term momentum when strong
- Exploit Polymarket repricing lag (BTC moved but token still cheap)
- Say "skip" when there's no real edge
- Not force trades on tiny moves (<0.005%)

### Guard Rails

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Max token price | $0.55 | Ensures 1.8x+ payout on wins |
| Min AI confidence | 60% | Don't trade on weak opinions |
| Positive EV | Required | Must beat Polymarket fees |
| Min balance | $2.50 | Don't trade with dust |
| Kelly fraction | 0.25 | Quarter-Kelly for conservative sizing |

### Sizing

Same proportional system as V2:
- Kelly fraction from Grok's confidence and token price
- Bet = `balance * lerp(10%, 50%, kelly_fraction)`
- Higher Grok confidence = larger bet within the range
- Floor at Polymarket minimum (~$2.50), cap at 50% of balance

---

## V3 vs V1 vs V2

| Dimension | V1 (Ensemble) | V2 (Sniper) | V3 (AI Trader) |
|-----------|---------------|-------------|----------------|
| Primary signal | 6 heuristic sub-strategies | 4 signal detectors | Grok AI prediction |
| Trade frequency | ~43% of windows | ~5% of windows | ~20-40% of windows |
| Max token price | $0.75 | $0.45 | $0.55 |
| Min voters | 1 (any strategy) | 2 (must agree) | 1 (Grok alone) |
| Sentiment | RSS + X (weight 0.10) | Disabled | X/Twitter via Grok native |
| Min confidence | 0.50 | 0.65 | 0.60 |
| Sizing | Fixed $2 | 10-50% Kelly | 10-50% Kelly |
| AI model | None | None | Grok grok-3-mini-fast |
| Latency per window | ~1s | ~1s | ~2-4s (API call) |

---

## Running V3

```bash
npm run btc:start:v3
```

Or via environment variable:

```bash
BTC_STRATEGY=v3 npm run btc:start
```

---

## Config

| Env Var | Default | Description |
|---------|---------|-------------|
| `BTC_STRATEGY` | `v1` | Set to `v3` for AI Trader |
| `GROK_API_KEY` | -- | Required. xAI API key for Grok |
| `BTC_V3_DISCORD_WEBHOOK_URL` | falls back to V1 URL | Discord webhook for V3 notifications |
| `BTC_MAX_BET_FRACTION` | `0.50` | Max fraction of bankroll per trade |
| `BTC_MIN_BET_FRACTION` | `0.10` | Min fraction of bankroll per trade |
| `BTC_MIN_BALANCE` | `2.50` | Stop trading below this balance |

---

## Log Format

V3 logs show the AI prediction inline:

```
[GROK-V3] Prediction: down 72% -- BTC dropped 0.08% with 140s left, market DOWN token at $0.35 is underpriced
Decision: down (ensemble-v3, confidence: 0.720) -- AI Trader: down 72% conf. Token: $0.350 (2.9x payout). Kelly: 0.264
```

Cycle log (`logs/btc-cycles.jsonl`) captures the same decision/trade/features structure as V1/V2 with `strategy: "ensemble-v3"`.

---

## Costs

Each Grok API call costs ~0.001-0.003 credits (grok-3-mini-fast is the cheapest model). At 12 windows/hour, that's roughly 288 calls/day or ~$0.30-0.90/day in API costs. This is negligible compared to trade sizes.

---

## Risks

- **API latency**: Grok calls take 1-3 seconds. If the API is slow or down, the bot falls back to "skip" (no trade). It doesn't block.
- **AI hallucination**: Grok might be confidently wrong. The guard rails (max token price, positive EV) limit downside.
- **Overfitting to recent context**: Grok's X/Twitter access could lead to trading on stale news. The prompt instructs it to focus on breaking events only.
- **Cost creep**: At high evaluation frequency, API costs could add up. Monitor Grok usage dashboard.

---

## Metrics to Track

| Metric | Target | How to Check |
|--------|--------|-------------|
| Win rate | >55% | state/btc-trading-state.json |
| Avg token price on entry | <$0.45 | Cycle log fillPrice |
| Trade frequency | 5-15/hour during active markets | Count cycle log entries |
| Grok skip rate | 30-60% | Count "AI says skip" in logs |
| Avg payout multiple on wins | >2.0x | 1 / avg fillPrice on winning trades |
| Net P&L per day | Positive | todayStats.totalPnl |
| API cost per day | <$1 | Grok dashboard |
