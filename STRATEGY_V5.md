# Strategy V5: Inverse Cramer

**Version**: V5 (Inverse Cramer)
**Activated**: March 12, 2026

---

## The Thesis

Jim Cramer is the avatar of retail trading psychology: momentum-chasing, FOMO-driven, panic-selling. He buys at tops and sells at bottoms. This is not a personal attack -- it's a documented statistical phenomenon. The "Inverse Cramer ETF" (ticker: SJIM) was literally created on this thesis.

V5 builds a full Cramer persona in Grok AI, feeds it real-time BTC data and social media sentiment, gets his loud confident call -- then **does the exact opposite**.

When "Cramer" screams BUY BUY BUY, we sell. When he panics and says GET OUT, we buy.

On 5-minute Polymarket windows, this exploits the fact that retail panic/FOMO creates temporary mispricings that mean-revert.

---

## How It Works

### Every 5 Minutes

1. Bot builds features: BTC price, momentum, volatility, Polymarket odds
2. Calls Grok with **Jim Cramer persona prompt** (temperature 0.7 for emotional volatility)
3. "Cramer" gives his call: UP or DOWN with high confidence (he's always confident)
4. Bot **inverts the direction**: Cramer says UP, we buy DOWN. Cramer says DOWN, we buy UP.
5. Guard rails apply: token cheap enough? Positive EV? Cramer confident enough?
6. Kelly-proportional sizing: more confident Cramer = stronger contrarian signal = bigger bet

### The Cramer Persona

Grok is instructed to BE Jim Cramer with these encoded biases:

| Bias | Behavior | How We Exploit It |
|------|----------|-------------------|
| Momentum chasing | BTC up 0.03%? "GOING MUCH HIGHER!" | We buy DOWN (momentum exhaustion) |
| Panic selling | BTC down 0.02%? "SELL EVERYTHING!" | We buy UP (mean reversion) |
| Headline overreaction | Any news = "CHANGES EVERYTHING" | We fade the overreaction |
| FOMO | Green candle = "TRAIN LEAVING STATION" | We bet on pullback |
| Crowd amplification | Crypto Twitter excited = 10x more excited | We go contrarian |
| Overconfidence | Always 65-95% confident | Higher confidence = stronger inverse signal |

### The Prompt

Cramer receives:
- Current BTC price and 1m/5m/window returns
- Volatility in basis points
- Polymarket odds (UP %/ DOWN %)
- Seconds remaining
- What X/Twitter and Reddit are saying right now

He is instructed to NEVER say "skip" or "I don't know." Cramer always has an opinion. The temperature is set to 0.7 (higher than V3's 0.3) to encourage emotional, reactive responses.

---

## Guard Rails

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Max token price | $0.55 | Ensures 1.8x+ payout on wins |
| Min confidence | 60% | Cramer is usually 65-95% confident, so this rarely blocks |
| Positive EV | Required | Must beat fees even on contrarian plays |
| Kelly sizing | 10-50% of bankroll | Higher Cramer confidence = bigger contrarian bet |
| Cramer must pick | Always UP or DOWN | No skip option -- forces a contrarian signal every window |

---

## V5 vs Other Strategies

| Dimension | V2 (Sniper) | V3 (AI Trader) | V5 (Inverse Cramer) |
|-----------|-------------|----------------|---------------------|
| Signal source | 4 heuristic detectors | Grok direct prediction | Grok Cramer persona (inverted) |
| Direction logic | Momentum + micro-structure | AI best guess | Contrarian / mean-reversion |
| Trade frequency | ~5% of windows | ~20-40% of windows | ~30-50% of windows |
| Grok temperature | N/A | 0.3 (analytical) | 0.7 (emotional) |
| "Skip" allowed | Yes (if <2 signals) | Yes (Grok can skip) | No (Cramer always has opinion) |
| Sizing | Kelly proportional | Kelly proportional | Kelly proportional |
| Best in | Trending, volatile markets | All conditions | Choppy, mean-reverting markets |

---

## Expected Behavior

- **Trades frequently** -- Cramer always has an opinion, so we almost always have a contrarian signal
- **Contrarian by nature** -- buys when retail panics, sells when retail FOMOs
- **Strongest in choppy markets** -- mean reversion works best when BTC oscillates
- **Weaker in strong trends** -- if BTC truly trends one direction for hours, the contrarian will be on the wrong side
- **High entertainment value** -- the logs show Cramer's rants before inversion

---

## Log Format

```
[CRAMER] Says: UP 82% -- BOOYAH! Bitcoin just jumped and it's going to the MOON! BUY BUY BUY!
[INVERSE-CRAMER] We go: DOWN 82%
Decision: down (ensemble-v5, confidence: 0.820) -- Inverse Cramer: down 82% conf. Token: $0.310 (3.2x payout). Kelly: 0.405
```

---

## Running V5

```bash
npm run btc:start:v5
```

---

## Config

| Env Var | Default | Description |
|---------|---------|-------------|
| `BTC_STRATEGY` | `v1` | Set to `v5` for Inverse Cramer |
| `GROK_API_KEY` | -- | Required. Same key as V3 |
| `BTC_V5_DISCORD_WEBHOOK_URL` | falls back to V1 URL | Discord webhook for V5 notifications |

---

## Risks

- **Strong trends**: If BTC trends hard in one direction, Cramer will be right and we'll be wrong. The contrarian bet loses in strong momentum.
- **Cramer sometimes right**: Even Cramer gets it right sometimes. The edge is statistical, not guaranteed per trade.
- **Persona drift**: Grok might not perfectly capture Cramer's biases every time. Temperature 0.7 helps but isn't deterministic.
- **API costs**: Same as V3 -- ~$0.30-0.90/day for Grok calls.

## Metrics to Track

| Metric | Target |
|--------|--------|
| Win rate | >52% (lower bar since we trade more often) |
| Avg token price on entry | <$0.45 |
| Trade frequency | 3-6 per hour |
| Cramer direction accuracy | <45% (he should be wrong more than right) |
| Net P&L per day | Positive |
| Best performance period | Choppy/ranging markets |
| Worst performance period | Strong trending markets |
