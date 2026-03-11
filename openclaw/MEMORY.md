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

## Current Trading Parameters (Survival Mode)

- Budget target: $2 per trade (set via `BTC_BUDGET_PER_TRADE=2`)
- Polymarket minimum: 5 tokens AND >$1 total value
- Actual cost per trade: ~$2.50 (5 tokens at market price)
- Account size: ~$10 USDC.e
- Execution adapter: Polymarket (live, not dry-run)
- Mode: survival -- tight thresholds, high-conviction trades only

## Strategy: Ensemble

The bot runs sub-strategies and combines them with weighted voting:

| Strategy | Weight | Min Confidence | What It Does |
|----------|--------|---------------|-------------|
| close-snipe | 0.40 | 0.64 | Late-window entry when BTC has moved significantly (>0.008%) |
| early-momentum | 0.30 | 0.62 | Enters 45-180s into window when market hasn't fully repriced BTC movement |
| momentum-orderbook | 0.20 | 0.58 | Combines BTC momentum with Polymarket orderbook imbalance |
| sentiment-gated | 0.10 | -- | Uses X/Twitter and news sentiment as trade filter |
| value-fade | 0.00 | -- | Disabled for survival mode |
| arbitrage | 0.00 | -- | Disabled |

### Ensemble Parameters

- Minimum ensemble confidence: **0.50** (weighted average must exceed this to trade)
- Maximum market price: **0.75** (won't buy if the token already costs >$0.75 -- payout too small)
- Positive EV filter: every trade must have positive expected value after Polymarket fees
- Kelly criterion sizing (capped) for position sizing within the budget

Decision timing: the bot evaluates at ~75 seconds into each 5-minute window, giving strategies time to detect an edge before the market fully reprices.

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
