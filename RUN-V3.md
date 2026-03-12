# Running Strategy V3: AI Trader

## What V3 Does

Every 5 minutes, V3 asks Grok AI: "Given BTC's current momentum, volatility, Polymarket odds, and what's trending on X/Twitter right now -- which direction is BTC going?" If Grok is confident and the token is cheap enough for good risk/reward, V3 places the trade.

V3 trades much more often than V2 because the AI has an opinion on most windows, not just rare microstructure setups.

---

## API Keys Required

| Key | Required? | What It Does | How to Get It |
|-----|-----------|-------------|---------------|
| `GROK_API_KEY` | **YES** | Grok AI predictions + live X/Twitter access | https://console.x.ai -- create API key |
| `POLYMARKET_PRIVATE_KEY` | **YES** | Places trades on Polymarket | https://reveal.magic.link/polymarket |
| `DISCORD_WEBHOOK_URL` | **YES** | Trade notifications | Discord server settings > Integrations > Webhooks |

You already have all three of these set in your `.env`.

### Optional (for richer data in the future)

| Key | What It Would Add |
|-----|-------------------|
| `EXA_API_KEY` | Real-time web search results about BTC fed into Grok's context |
| `PERPLEXITY_API_KEY` | Alternative real-time search for BTC news/analysis |
| `RSS_APP_API_KEY` + `RSS_APP_API_SECRET` | Custom RSS feed monitoring via RSS.app |

These are not needed right now. V3 already gets:
- **X/Twitter**: Grok has native real-time access to X posts, trending topics, and crypto influencer activity
- **Reddit**: RSS scraping of r/bitcoin, r/cryptocurrency, r/bitcoinmarkets (top posts)
- **News**: RSS scraping of CoinDesk, CoinTelegraph, Bitcoin Magazine headlines

All of this is fed to Grok alongside the BTC price data when it makes its prediction.

---

## What Grok Sees Every 5 Minutes

When V3 calls Grok, it sends:

```
BTC price: $70,500.00
1-minute return: +0.045%
5-minute return: -0.012%
Window return (since this window opened): +0.038%
Volatility (5m): 4.2 basis points
Polymarket UP token: $0.350 (35%)
Polymarket DOWN token: $0.650 (65%)
Time remaining: 140s

Recent context: [X/Twitter] BTC consolidating near $70.5k, no breaking events;
[News] CoinDesk: Bitcoin ETF inflows hit $500M; [Reddit] BTC holding strong above $70k
```

Grok responds with: `{ direction: "up", confidence: 0.68, reasoning: "..." }`

---

## Quick Start

### 1. Make sure VPN is connected to Brazil

```bash
curl -s https://polymarket.com/api/geoblock | cat
```

Must return `{"blocked":false}`.

### 2. Kill any running bot and start V3

```bash
cd ~/projects/btc-trader
pkill -f "btc-trader/index.ts" 2>/dev/null
sleep 2
nohup npm run btc:start:v3 > logs/btc-trader.log 2>&1 &
```

### 3. Watch it run

```bash
tail -f logs/btc-trader.log
```

You should see:
```
Strategy: ensemble-v3 (v3)
[GROK-V3] Prediction: down 72% -- BTC dropped 0.08% with 140s left...
Decision: down (ensemble-v3, confidence: 0.720) -- AI Trader: down 72% conf...
[POLYMARKET] Placing order: down 8 tokens @ $0.35...
```

### 4. Check status

```bash
npm run btc:status
cat state/btc-trading-state.json
```

### 5. Switch back to V2

```bash
pkill -f "btc-trader/index.ts" 2>/dev/null
sleep 2
nohup npm run btc:start:v2 > logs/btc-trader.log 2>&1 &
```

---

## OpenClaw Prompt for V3

Paste this into OpenClaw:

```
Clean start the BTC 5-minute trading bot with Strategy V3 (AI Trader).

1. Read operating docs:
   - ~/projects/btc-trader/openclaw/MEMORY.md
   - ~/projects/btc-trader/openclaw/AGENTS.md
   - ~/projects/btc-trader/STRATEGY_V3.md

2. Pull latest code:
   cd ~/projects/btc-trader && git pull

3. Install dependencies:
   cd ~/projects/btc-trader && npm install

4. Verify VPN (Brazil):
   curl -s https://polymarket.com/api/geoblock | cat

5. Verify GROK_API_KEY is set:
   grep GROK_API_KEY ~/projects/btc-trader/.env

6. Kill all existing processes:
   pkill -f "btc-trader/index.ts" 2>/dev/null; sleep 2

7. Start V3:
   cd ~/projects/btc-trader && nohup npm run btc:start:v3 > logs/btc-trader.log 2>&1 &

8. Wait 30s, verify:
   tail -30 ~/projects/btc-trader/logs/btc-trader.log
   Should see: Strategy: ensemble-v3 (v3)
   Should see: [GROK-V3] Prediction lines

Report: VPN status, balance, adapter, strategy version, any errors.
```

---

## Monitoring V3

V3 makes a Grok API call at every evaluation checkpoint (75s, 150s, 220s, 260s into each window). Watch for:

- **`[GROK-V3] Prediction: up/down X%`** -- Grok made a call
- **`[GROK-V3] Prediction: skip`** -- Grok says no edge (expected ~30-60% of windows)
- **`AI says skip`** -- abstained because Grok said skip
- **`Token too expensive`** -- Grok said trade but token was >$0.55
- **`Negative EV`** -- Grok confident but EV doesn't work after fees

If you see mostly skips, BTC is probably flat. During volatile periods you should see trades every few minutes.

---

## Cost Estimate

- Grok `grok-3-mini-fast`: ~$0.001-0.003 per call
- ~288 calls/day (12 windows/hour * 24 hours, evaluating at each checkpoint)
- **~$0.30-0.90/day** in API costs
- Negligible compared to trade sizes

---

## Claiming Winnings

Same as always -- the bot CANNOT auto-claim. When you win:
1. Go to https://polymarket.com/portfolio
2. Click **Claim** on winning positions
3. Check balance periodically -- if it drops below $5, claim immediately
