# Strategy V2: Late-Window Sniper

## Why V2 Exists

V1 (the original ensemble) was analysed over 171 windows and 74 trades. Results:

- **0 wins, 2 losses, -$6 P&L**
- 43% trade rate (trading on noise, not edge)
- 77% UP bias (sentiment/momentum have bullish lean)
- 27% of trades bought tokens above $0.60 (risking $3.50 to make $1.50)
- sentiment-gated was the sole voter on 32 trades (stale RSS/Twitter data)
- close-snipe (the real edge) only fired 7 times

The core problem: most strategies generate high confidence on tiny BTC moves (0.03-0.05%) that are random noise. Buying expensive tokens ($0.60+) on near-random signals guarantees losses.

---

## V2 Philosophy

**Trade rarely. Buy cheap. Require agreement.**

The only real edge on 5-minute markets is **market microstructure inefficiency**: BTC moves but Polymarket token prices lag. V2 exploits this by:

1. Only buying tokens below $0.45 (minimum 2.2x payout)
2. Requiring at least 2 independent signals to agree
3. Ignoring sentiment entirely (useless at 5-minute horizon)
4. Focusing on late-window entries (150-260s) where repricing lag is exploitable
5. Sizing bets proportionally to conviction (10-50% of bankroll via Kelly)

---

## How It Works

### Four Independent Signals

V2 collects signals from 4 independent detectors. Each returns a direction (up/down) and confidence, or nothing.

| Signal | What It Detects | Fires When |
|--------|-----------------|------------|
| **close-snipe** | BTC moved, market hasn't repriced, late in window | 15-200s remaining, move > 0.005%, conf > 0.58 |
| **momentum** | Clear BTC price direction | Move > 0.03%, 1m and 5m returns align, conf > 0.58 |
| **orderbook** | Polymarket depth imbalance suggests pressure | Imbalance > 0.15, conf > 0.58 |
| **divergence** | BTC moved but token is still very cheap | Move > 0.03%, token < $0.40, conf > 0.60 |

### Ensemble Rules

1. Minimum BTC move: 0.03% (global filter before any signal runs)
2. At least **2 signals must agree** on direction (no single-voter trades)
3. Ensemble confidence = average of agreeing signals, penalized by disagreement
4. Minimum ensemble confidence: **0.65**
5. Maximum token price: **$0.45** (never buy expensive tokens)
6. Positive EV after Polymarket fees

### Proportional Sizing

Instead of fixed $2 bets:

- Kelly fraction computed from edge and odds
- Bet size = `balance * lerp(10%, 50%, kelly)`
- High conviction (Kelly > 0.5) = bet up to 50% of bankroll
- Low conviction (Kelly ~ 0) = bet minimum 10%
- Won't trade if balance < $2.50

### Evaluation Checkpoints

V2 adds a 4th checkpoint at 260s (40s remaining) specifically for close-snipe:

| Checkpoint | Seconds Into Window | Primary Signal |
|------------|--------------------:|----------------|
| 1st | 75s | momentum, orderbook |
| 2nd | 150s | all signals |
| 3rd | 220s | close-snipe focus |
| 4th (V2 only) | 260s | close-snipe last chance |

---

## Running V2

### Via npm script

```bash
npm run btc:start:v2
```

### Via environment variable

```bash
BTC_STRATEGY=v2 npm run btc:start
```

### In .env

```
BTC_STRATEGY=v2
```

### Switching back to V1

```bash
npm run btc:start:v1
# or
BTC_STRATEGY=v1 npm run btc:start
```

Default (no env var) is `v1`.

---

## V2 vs V1 Comparison

| Dimension | V1 (Ensemble) | V2 (Sniper) |
|-----------|---------------|-------------|
| Trade rate | ~43% of windows | ~5-10% of windows |
| Max token price | $0.75 | $0.45 |
| Min payout multiple | 1.33x | 2.22x |
| Min voters required | 1 (any strategy) | 2 (must agree) |
| Sentiment | Used (weight 0.10) | Disabled |
| Bet sizing | Fixed $2 | 10-50% of bankroll |
| Min BTC move | None | 0.03% |
| Min confidence | 0.50 | 0.65 |
| Checkpoints | 75, 150, 220 | 75, 150, 220, 260 |
| Sub-strategies | 6 (separate classes) | 4 (inline signals) |

---

## Expected Behavior

- **Much fewer trades** -- maybe 2-5 per day instead of 30+
- **Bigger bets when it does trade** -- 10-50% of bankroll vs fixed $2
- **Better risk/reward** -- cheap tokens mean wins pay 2x+ vs 1.2x
- **Late-window focus** -- most trades at 150-260s where repricing lag exists
- **No sentiment noise** -- purely data-driven from price, orderbook, and market prices

---

## Logs

V2 logs include strategy name `ensemble-v2` and sizing details:

```
Strategy: ensemble-v2 (v2)
V2 sizing: Kelly=0.350, fraction=24.0%, budget=$3.84 of $16.00
V2 Sniper: up 0.720 conf. Signals: [close-snipe:0.71, momentum:0.73]. 2/3 agree. Token: $0.28. Kelly: 0.350
```

Compare with V1 logs which show `ensemble (v1)`.

---

## Config Reference

| Env Var | Default | Description |
|---------|---------|-------------|
| `BTC_STRATEGY` | `v1` | `v1` for original ensemble, `v2` for sniper |
| `BTC_MAX_BET_FRACTION` | `0.50` | V2: max fraction of bankroll per trade |
| `BTC_MIN_BET_FRACTION` | `0.10` | V2: min fraction of bankroll per trade |
| `BTC_MIN_BALANCE` | `2.50` | V2: stop trading below this balance |
| `BTC_V2_DISCORD_WEBHOOK_URL` | *(hardcoded)* | Discord webhook for V2 notifications |

---

## Logging and Evaluation

### Log Files

Each strategy writes to its own log files so performance can be compared:

| File | Purpose |
|------|---------|
| `logs/btc-cycles-v1.jsonl` | Per-window cycle log for V1 (decisions, trades, features) |
| `logs/btc-cycles-v2.jsonl` | Per-window cycle log for V2 |
| `logs/btc-trader.log` | Combined text log (both strategies) |
| `logs/btc-trader-error.log` | Errors only |
| `state/btc-trading-state.json` | Current state: today stats, cumulative stats, balance |
| `state/btc-system-health.json` | Health heartbeat: price, balance, adapter |

### Discord Webhooks

V1 and V2 send notifications to **separate Discord channels** so you can track each independently:

- **V1** uses `DISCORD_WEBHOOK_URL`
- **V2** uses `BTC_V2_DISCORD_WEBHOOK_URL`

Every notification is tagged with `[V1]` or `[V2]` in the title, and the footer shows `BTC Trader V1` or `BTC Trader V2`.

### Cycle Log Format (btc-cycles-vX.jsonl)

Each line is a JSON object:

```json
{
  "windowSlug": "btc-updown-5m-1773256800",
  "epochStart": 1773256800,
  "epochEnd": 1773257100,
  "btcPriceAtStart": 70529.40,
  "decisions": [{
    "direction": "up",
    "confidence": 0.757,
    "strategy": "ensemble-v2",
    "reasoning": "V2 Sniper: up 0.757 conf. Signals: [close-snipe:0.71, momentum:0.73]. 2/2 agree. Token: $0.28. Kelly: 0.350",
    "suggestedSize": 0.35
  }],
  "trades": [{
    "order": { "direction": "up", "price": 0.285, "size": 12, "strategy": "ensemble-v2" },
    "filled": true,
    "fillPrice": 0.28,
    "fillSize": 12,
    "fee": 0,
    "pnl": 0
  }],
  "features": {
    "btcPrice": 70529.40,
    "btcReturn1m": 0.000458,
    "btcReturn5m": 0.000649,
    "impliedProbUp": 0.28,
    "impliedProbDown": 0.72,
    "sentimentScore": 0.0
  },
  "timestamp": "2026-03-11T12:21:16.000Z"
}
```

### How to Analyse Performance

**Quick stats from the command line:**

```bash
# Count trades vs abstentions for V2
python3 -c "
import json
trades, abstains, total = 0, 0, 0
with open('logs/btc-cycles-v2.jsonl') as f:
    for line in f:
        d = json.loads(line)
        total += 1
        if d['trades']:
            trades += 1
        elif d['decisions'][0]['direction'] == 'abstain':
            abstains += 1
print(f'Total: {total}, Trades: {trades}, Abstains: {abstains}, Trade rate: {trades/max(total,1)*100:.1f}%')
"

# Win/loss from state file
cat state/btc-trading-state.json | python3 -c "
import json, sys
s = json.load(sys.stdin)
t = s['todayStats']
print(f'Today: {t[\"wins\"]}W/{t[\"losses\"]}L, P&L: \${t[\"totalPnl\"]:.2f}')
c = s['cumulativeStats']
print(f'All time: {c[\"wins\"]}W/{c[\"losses\"]}L, WR: {c[\"winRate\"]*100:.0f}%, P&L: \${c[\"totalPnl\"]:.2f}')
"

# Extract all trade details for V2
python3 -c "
import json
with open('logs/btc-cycles-v2.jsonl') as f:
    for line in f:
        d = json.loads(line)
        if not d['trades']: continue
        dec = d['decisions'][0]
        tr = d['trades'][0]
        print(f'{d[\"timestamp\"]} | {dec[\"direction\"].upper()} @ \${tr[\"fillPrice\"]:.2f} x{tr[\"fillSize\"]} | conf={dec[\"confidence\"]:.3f} | {dec[\"reasoning\"][:80]}')
"
```

### How to Pass Data to an AI for Evaluation

The cycle logs and Discord messages are designed to be directly consumable by an AI model. To evaluate strategy performance:

1. **Export the cycle log** -- copy the contents of `logs/btc-cycles-v2.jsonl`
2. **Or screenshot the Discord channel** -- each message has strategy tag, direction, confidence, token price, P&L, and balance
3. **Paste to an AI with this prompt:**

```
Here are the trading logs from my BTC 5-minute Polymarket bot running strategy V2.
Each line is one 5-minute window evaluation. Please analyse:

1. Win rate and P&L breakdown
2. Which signals (close-snipe, momentum, orderbook, divergence) contribute most to wins vs losses
3. Average token price on winning vs losing trades
4. Are there patterns in when the strategy loses? (time of day, BTC volatility, market conditions)
5. Specific parameter adjustments that could improve performance
6. Should any signals be removed or reweighted?

[paste logs/btc-cycles-v2.jsonl contents here]
```

### What to Compare Between V1 and V2

| Metric | How to Check | Good V2 Result |
|--------|-------------|----------------|
| Trade rate | Count trades / total windows | 5-15% (not 43% like V1) |
| Avg token price | Mean fillPrice of trades | < $0.40 (not $0.60+ like V1) |
| Win rate | wins / (wins + losses) | > 55% |
| Avg payout multiple | 1 / avg fillPrice | > 2.0x |
| P&L per trade | totalPnl / trades | Positive |
| Signal agreement | How often 2+ signals agree | Most trades should show 2-3 signals |
| Sizing | Avg bet as % of bankroll | 15-30% (Kelly-driven) |
