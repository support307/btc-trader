# BTC 5-Minute Trader

Autonomous bot that trades Polymarket's "Bitcoin Up or Down" 5-minute prediction markets. Every 5 minutes a new market opens asking whether BTC will be higher or lower at the end of the window. The bot watches real-time BTC price via Binance, detects when Polymarket odds haven't caught up to a known move, and buys the likely winning side before the window closes. It's not predicting BTC -- it's exploiting slow repricing.

## Prerequisites

- **Node.js** 18+
- **NordVPN** connected to **Brazil** (Polymarket is geo-blocked in the US)
- **Polymarket account** with USDC.e balance and a Magic.Link proxy wallet
- **Polymarket CLI**: `npm install -g @polymarket/cli`

## Setup

```bash
git clone git@github.com:support307/btc-trader.git
cd btc-trader
npm install
```

Create `.env` from the example and fill in your keys:

```bash
cp .env.example .env
```

Required keys in `.env`:

| Key | What It Is |
|-----|-----------|
| `POLYMARKET_PRIVATE_KEY` | Your wallet private key (starts with `0x`). Export from https://reveal.magic.link/polymarket |
| `DISCORD_WEBHOOK_URL` | Discord webhook for trade notifications |
| `GROK_API_KEY` | xAI Grok key for X/Twitter sentiment |
| `BTC_DRY_RUN` | Set to `false` for real trading |
| `BTC_EXECUTION_ADAPTER` | Set to `polymarket` for real trading |

Verify your Polymarket wallet is configured:

```bash
polymarket wallet show
```

Verify VPN is connected (must return `{"blocked":false}`):

```bash
curl -s https://polymarket.com/api/geoblock | cat
```

## Running

**Start** (background):

```bash
mkdir -p logs state
nohup npm run btc:start > logs/btc-trader.log 2>&1 &
```

**Start** (foreground, for debugging):

```bash
npm run btc:start
```

**Stop**:

```bash
kill $(cat state/btc-trader.pid) 2>/dev/null
pkill -f "btc-trader/index.ts" 2>/dev/null
```

**Check status**:

```bash
npm run btc:status
cat state/btc-trading-state.json
cat state/btc-system-health.json
tail -30 logs/btc-trader.log
```

**Backtest**:

```bash
npm run btc:backtest:1d   # last 24 hours
npm run btc:backtest:7d   # last 7 days
```

## Configuration

All settings are in `.env`. Key knobs:

| Setting | Default | What It Does |
|---------|---------|-------------|
| `BTC_BUDGET_PERCENT` | `25` | % of available balance to risk per trade |
| `BTC_BUDGET_MAX` | `20` | Max dollars per trade regardless of balance |
| `BTC_BUDGET_PER_TRADE` | `2` | Fallback fixed budget if percent is 0 |
| `BTC_MIN_CONFIDENCE` | `0.60` | Global minimum confidence to trade |
| `BTC_DRY_RUN` | `false` | `true` = simulated trades, `false` = real money |
| `BTC_EXECUTION_ADAPTER` | `polymarket` | `polymarket` for live, `dry-run` for paper |

## How It Works

**The edge**: Polymarket reprices its 5-minute BTC markets slower than BTC actually moves. When BTC moves 0.01%+ with 40 seconds left and the Polymarket token is still cheap, the bot buys it.

**Strategy**: Close-snipe dominant ensemble (60% weight). The bot evaluates at 75s, 150s, 220s, and 260s into each 5-minute window. The 260s checkpoint is where the real edge lives -- Polymarket is slowest to reprice in the final seconds.

**Sizing**: Dynamic -- 25% of available balance per trade, scaled by Kelly fraction (higher confidence = larger bet within that 25%). Floored at ~$2.50 (Polymarket minimum), capped at $20.

**Volatility gate**: If BTC volatility over the last 5 minutes is below 5 basis points, the window is skipped. No movement = no repricing lag = no edge.

**What the bot does every 5 minutes**:
1. Checks if BTC volatility is high enough (skip if flat)
2. Fetches current Polymarket market and orderbook
3. Computes true window-start-to-now BTC return
4. Runs ensemble strategy (close-snipe + 3 supporting strategies)
5. If confidence > 0.50 and positive expected value: places a buy order
6. After window closes: checks outcome, reports win/loss to Discord

## Claiming Winnings (Manual)

The bot **cannot auto-claim** winning positions. Polymarket's CLI doesn't support redemption with Magic.Link proxy wallets.

When the bot wins, you must manually claim:
1. Go to https://polymarket.com/portfolio
2. Click **Claim** on winning positions
3. This recycles USDC.e back into your available balance

If you don't claim, the bot will eventually run out of funds even while winning.

## Discord Notifications

The bot sends color-coded embeds to your Discord webhook:

- **Entry** (blue): direction, confidence, price, strategy breakdown
- **Fill** (green): order confirmed with Polymarket order ID
- **Skip** (grey): why the bot abstained this window
- **Win** (green) / **Loss** (red): outcome, P&L, balance, daily stats
- **Daily summary**: wins, losses, net P&L, balance

## OpenClaw Integration

If you use OpenClaw as your AI assistant, see `openclaw/DAILY-START.md` for copy-paste prompts that handle the full startup procedure (git pull, npm install, VPN check, zombie cleanup, and bot start) in one shot.

Supporting docs for OpenClaw:
- `openclaw/SOUL.md` -- persona and tone
- `openclaw/AGENTS.md` -- monitoring and operations
- `openclaw/MEMORY.md` -- account details and strategy parameters

## Project Structure

```
src/btc-trader/
  index.ts              # main daemon loop
  config.ts             # env-based configuration
  types.ts              # shared type definitions
  strategies/
    ensemble.ts         # weighted strategy aggregation
    close-snipe.ts      # primary strategy (repricing lag)
    early-momentum.ts   # early-window momentum
    momentum-orderbook.ts
    sentiment-gated.ts
    value-fade.ts       # disabled
    arbitrage.ts        # disabled
  features/
    feature-vector.ts   # builds features from raw data
    price-features.ts   # BTC return/vol/momentum
    orderbook-features.ts
    fees.ts             # Polymarket fee model + EV calculation
  data/
    binance-ws.ts       # real-time BTC price feed
    clob-client.ts      # Polymarket orderbook
    gamma-client.ts     # market discovery
    news-feed.ts        # RSS + Grok sentiment
  execution/
    polymarket-exec.ts  # live Polymarket order execution
    dry-run.ts          # simulated execution
  state/
    trading-state.ts    # state persistence
  notifications/
    notifier.ts         # Discord webhook notifications
  clock/
    market-clock.ts     # 5-minute window timing
    logger.ts           # Winston logger
state/                  # runtime state files (gitignored)
logs/                   # runtime logs (gitignored)
openclaw/               # AI assistant docs
```
