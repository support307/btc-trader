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

## Strategy Selection

The bot supports two strategies, switchable via `BTC_STRATEGY` env var:

- **V1** (`BTC_STRATEGY=v1`, default): Original 6-strategy ensemble with weighted voting
- **V2** (`BTC_STRATEGY=v2`): "Late-Window Sniper" -- cheap tokens only, 2+ voter requirement, proportional sizing

Run with: `npm run btc:start:v1` or `npm run btc:start:v2`

Full V2 documentation: `~/projects/btc-trader/STRATEGY_V2.md`

### V1: Original Ensemble

- Budget: fixed $2 per trade (`BTC_BUDGET_PER_TRADE=2`)
- Max token price: $0.75
- Min ensemble confidence: 0.50
- 6 sub-strategies with weighted voting (close-snipe 0.40, early-momentum 0.30, momentum-orderbook 0.20, sentiment 0.10)
- Checkpoints: 75s, 150s, 220s

### V2: Late-Window Sniper

- Budget: proportional 10-50% of bankroll (based on Kelly sizing)
- Max token price: **$0.45** (2.2x+ payout on wins)
- Min ensemble confidence: **0.65**
- Min BTC move: **0.03%** (filters noise)
- Requires **2+ signals to agree** (no single-voter trades)
- No sentiment (useless at 5-min horizon)
- 4 inline signals: close-snipe, momentum, orderbook, divergence
- Checkpoints: 75s, 150s, 220s, **260s** (late-window extra)

### Current Account

- Account size: ~$10 USDC.e
- Polymarket minimum: 5 tokens AND >$1 total value
- Execution adapter: Polymarket (live, not dry-run)

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

## Log Files and State

| File | Purpose |
|------|---------|
| `state/btc-trading-state.json` | Current window, today stats, cumulative stats, balance |
| `state/btc-system-health.json` | Health heartbeat: price, balance, adapter |
| `logs/btc-cycles-v1.jsonl` | Per-window cycle log for V1 (decisions, trades, features) |
| `logs/btc-cycles-v2.jsonl` | Per-window cycle log for V2 |
| `logs/btc-trader.log` | Combined text log (both strategies) |
| `logs/btc-trader-error.log` | Errors only |

V1 and V2 use **separate Discord webhooks** so notifications don't mix. Each message is tagged `[V1]` or `[V2]`.

To evaluate strategy performance, pass `logs/btc-cycles-v2.jsonl` to an AI. See `STRATEGY_V2.md` for analysis commands and the evaluation prompt template.

## Commands

- **Start (default/v1)**: `cd ~/projects/btc-trader && npm run btc:start`
- **Start V1 explicitly**: `npm run btc:start:v1`
- **Start V2 (sniper)**: `npm run btc:start:v2`
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
- Mar 11: V1 analysis (171 windows, 74 trades): 0 wins, 2 losses, -$6. Core problems: buying expensive tokens ($0.60+), sentiment-only trades (32 of 74), 77% UP bias. Created V2 "Late-Window Sniper" strategy focused on cheap tokens only, 2+ voter agreement, proportional sizing.
