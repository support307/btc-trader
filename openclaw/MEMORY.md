# MEMORY.md -- BTC 5-Minute Trader

## System Overview

I manage the BTC 5-Minute Trader at `~/projects/btc-trader` -- an autonomous bot that trades on Polymarket's "Bitcoin Up or Down" 5-minute prediction markets.

The entry point is `src/btc-trader/index.ts`.

---

## Polymarket Account

- Wallet address: `0xE8BDf64bBCB4d77462E15083E17223bb6eEF875B`
- Wallet type: Magic.Link proxy wallet (signature_type: "proxy")
- Private key: `.env` as `POLYMARKET_PRIVATE_KEY` and `~/.config/polymarket/config.json`
- Chain: Polygon (chain_id 137)
- Currency: USDC.e

## Current Trading Parameters (Edge Overhaul)

- **Dynamic sizing**: 25% of available balance per trade (`BTC_BUDGET_PERCENT=25`), floored at ~$2.50 (Polymarket minimum), capped at $20
- Kelly fraction scales the 25% -- higher confidence = larger bet within that range
- Polymarket minimum: 5 tokens AND >$1 total value
- Account size: ~$10 USDC.e
- Execution adapter: Polymarket (live, not dry-run)
- Mode: close-snipe dominant -- exploiting Polymarket repricing lag, not predicting BTC

## Strategy: Ensemble (Close-Snipe Dominant)

The edge: Polymarket odds lag real BTC movement by seconds. We're not predicting BTC direction; we're exploiting slow repricing near window close.

| Strategy | Weight | Min Confidence | What It Does |
|----------|--------|---------------|-------------|
| close-snipe | **0.60** | 0.64 | Late-window entry when BTC has moved and Polymarket hasn't fully repriced |
| early-momentum | 0.20 | 0.62 | Enters 45-180s when market hasn't repriced BTC movement |
| momentum-orderbook | 0.15 | 0.58 | Combines BTC momentum with Polymarket orderbook imbalance |
| sentiment-gated | 0.05 | -- | Uses X/Twitter sentiment (event-risk veto mainly) |
| value-fade | 0.00 | -- | Disabled |
| arbitrage | 0.00 | -- | Disabled |

### Ensemble Parameters

- Minimum ensemble confidence: **0.50** (weighted average must exceed this to trade)
- Maximum market price: **0.75** (won't buy if the token already costs >$0.75 -- payout too small)
- Positive EV filter: every trade must have positive expected value after Polymarket fees
- Zero-weight strategies are excluded from agreement math (prevents false abstains)
- Kelly criterion sizes trades within the dynamic budget

### Key Features

- **`windowReturn`**: true BTC return since this specific window opened (not rolling 5m). This is close-snipe's primary signal.
- **Volatility gate**: windows with <5bps volatility are skipped entirely (no edge to exploit when BTC is flat)
- **Evaluation checkpoints**: `[75, 150, 220, 260]` seconds -- the 260s checkpoint gives close-snipe one last shot in the final 40 seconds when repricing lag is strongest
- **Per-window trade tracking**: each trade is keyed by window epoch for correct PnL attribution

## Data Sources

- **Binance WebSocket**: Real-time BTC/USDT price (primary signal)
- **Polymarket CLOB API**: Orderbook depth, market odds, price history
- **Polymarket Gamma API**: Market discovery (finds current 5-min window market)
- **xAI Grok** (`GROK_API_KEY`): X/Twitter sentiment analysis from crypto influencers
- **RSS feeds**: CoinDesk, CoinTelegraph, Bitcoin Magazine, Reddit (news sentiment)

## Critical Limitation: Cannot Auto-Claim Winnings

The Polymarket CLI's `ctf redeem` command does NOT work with Magic.Link proxy wallets. The bot detects redeemable positions and logs a notification, but **cannot execute the claim**. The user MUST manually claim at https://polymarket.com/portfolio by clicking "Claim".

Always remind the user to claim when you see redeemable positions or low balance warnings.

## VPN Requirement

Polymarket is geo-blocked in the US. NordVPN must be connected to **Brazil** before starting. Verify with:

```bash
curl -s https://polymarket.com/api/geoblock | cat
```

## Process Management

- **PID file**: `state/btc-trader.pid` -- written at startup, checked on restart
- On startup, kills any previous instance before starting
- On shutdown (SIGINT/SIGTERM), PID file is cleaned up
- Prevents zombie processes (previously a major issue that drained the account)

## State and Health Files

- **Trading state**: `~/projects/btc-trader/state/btc-trading-state.json` -- current window, positions, daily stats
- **Health file**: `~/projects/btc-trader/state/btc-system-health.json` -- updated every tick with price, balance

## Commands

- **Start**: `cd ~/projects/btc-trader && npm run btc:start`
- **Status**: `npm run btc:status`
- **Backtest 1 day**: `npm run btc:backtest:1d`
- **Backtest 7 days**: `npm run btc:backtest:7d`
- **Stop**: `kill $(cat ~/projects/btc-trader/state/btc-trader.pid)` or `pkill -f "btc-trader/index.ts"`

## Notifications

Discord webhook sends color-coded embeds for:
- **Entry** (blue): direction, confidence, price, sub-strategy breakdown
- **Fill** (green): order confirmed with Polymarket order ID
- **Skip** (grey): why the bot abstained this window
- **Resolution** (green/red): win or loss, P&L, balance, daily stats
- **Daily summary**: wins, losses, net P&L, balance

## Lessons Learned

- Mar 10: Zombie processes (10+ instances) drained account from $20 to $1. Fixed with PID file management.
- Mar 10: Polymarket CLI cannot redeem proxy wallet positions. Switched to manual-claim notifications.
- Mar 10: Bot needs to enter early in the window (~75s) to find edge. At 220s+ the market has already priced in BTC movement.
- Mar 10: Polymarket minimum order is 5 tokens AND >$1 total. Size calculation must account for both.
- Mar 10: EV calculation had a bug double-complementing down-bet prices. Fixed -- both sides now use token price directly.
- Mar 10: Survival mode activated -- lowered budget to $2, raised confidence thresholds, disabled value-fade, boosted close-snipe weight to 0.40. Goal: preserve capital and grow steadily with high-conviction trades.
- Mar 11: Edge overhaul -- shifted to close-snipe dominant (0.60 weight), added true window-start return feature, added late 260s checkpoint, added volatility gate (skip <5bps windows), switched to dynamic 25%-of-balance sizing with Kelly scaling, fixed trade-to-window attribution bug.
