# How It Works -- Full System Documentation

> This document explains every aspect of the btc-trader project from scratch. It covers both independent trading systems, their architecture, data flows, strategies, risk management, and operational procedures. All times are PST unless stated otherwise.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [System 1: Discord Guru-Follow Trader](#2-system-1-discord-guru-follow-trader)
3. [System 2: BTC 5-Minute Trader](#3-system-2-btc-5-minute-trader)
4. [Shared Infrastructure](#4-shared-infrastructure)
5. [Operational Guide](#5-operational-guide)
6. [File Structure](#6-file-structure)

---

## 1. Project Overview

This repository contains **two independent automated trading systems** running as Node.js/TypeScript daemons:

| System | What It Trades | Where | Budget | Entry Point |
|--------|---------------|-------|--------|-------------|
| **Discord Guru-Follow** | 0DTE SPY/IWM/QQQ options | Alpaca | $2,000/trade | `src/index.ts` |
| **BTC 5-Minute Trader** | Polymarket BTC up/down prediction markets | Polymarket / Alpaca / Dry-run | $50/trade | `src/btc-trader/index.ts` |

Both are backend-only (no web UI, no database), use file-based JSON state persistence, and communicate via Discord webhooks. They share a Node.js runtime and some config but run as separate processes.

### Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Runtime | Node.js + TypeScript (ES2022) | Application code |
| Execution | `tsx` | Run TypeScript directly without build step |
| Process manager | PM2 | Auto-restart, crash recovery, logging |
| Broker (options) | Alpaca Trading API | Options orders, positions, account data |
| Broker (crypto) | Polymarket CLOB / Alpaca Crypto | BTC prediction markets / spot BTC |
| Signal source | Discord REST API | Polling guru's messages (user token) |
| Price data | Binance WebSocket | Real-time BTC/USDT trade stream |
| Market data | Polymarket Gamma API | 5-minute BTC up/down market discovery |
| AI classification | Anthropic Claude | Primary message classifier (text + images) |
| AI fallback | xAI Grok | Secondary classifier, sentiment analysis, X/Twitter access |
| Sentiment | RSS feeds + Reddit + Grok | News and social sentiment scoring |
| Notifications | Discord Webhooks | Trade alerts, position updates, errors |
| State | JSON files on disk | `state/trading-state.json`, `state/btc-trading-state.json` |
| Logging | Winston | Console + file transports with levels |

---

## 2. System 1: Discord Guru-Follow Trader

### What It Does

Monitors a private Discord channel where a trading guru (**Stocksandrealestate**) posts real-time trade signals for 0DTE options. When the guru posts an entry signal, the bot buys options on Alpaca. When the guru posts an exit signal, the bot sells. If the guru never posts an exit, the bot force-closes everything at 12:40 PM PST.

```
Guru posts in Discord --> Bot polls the message --> LLM classifies it --> Bot executes on Alpaca
```

### Architecture

```
PM2 (auto-restart, crash recovery, max 50 restarts)
  |
  +-- Main Daemon Process (src/index.ts)
        |
        +-- Discord REST API (polling every 3s / 10s / 60s)
        |     +-- LLM Classifier (Claude primary, Grok fallback, regex last resort)
        |           +-- Guru Trade Manager (entry/exit lifecycle)
        |                 +-- Alpaca Trading API (limit buy, market sell)
        |                 +-- Pre-market entry queue (auto-retry at 6:30 AM)
        |                 +-- Sell retry (3x immediate + pendingSell every 10s)
        |                 +-- Reconciliation (state <-> Alpaca sync every 60s)
        |
        +-- Safety Check Loop (every 10s)
        |     +-- 12:40 PM EOD force close
        |     +-- Pending sell retries
        |     +-- Position existence verification
        |
        +-- Notifications
              +-- Discord Webhook (primary, 3x retry with backoff)
              +-- [NOTIFY] stdout (fallback)

Optional:
  Streamer (streamer/index.js) -- Alpaca OPRA WebSocket, backup 12:40 PM close
```

### Message Classification

Every guru message is classified into one of six types using a three-tier pipeline:

1. **Claude LLM** (primary) -- understands context, reads images, handles ambiguity. 5s timeout.
2. **Grok LLM** (fallback) -- fast, decent at classification. Used when Claude fails or confidence < 70%.
3. **Regex patterns** (last resort) -- deterministic pattern matching when both LLMs fail.

| Type | Example Messages | Bot Action |
|------|-----------------|------------|
| GAMEPLAN | "Todays gameplan $SPY", "The calls im watching" | Track tickers, notify. No trade. |
| ENTRY | "$IWM Call at $265 at 0.18" (ticker + strike + price) | BUY options with $2,000 budget |
| SCALE_IN | "Adding here", "better fill" | HOLD. Never buy more -- one buy per day. |
| UPDATE | "Absolutely cooking", "250% gain" | Notify only. No trade action. |
| PARTIAL_EXIT | "Sell half", "to be safe" | SELL HALF the position, keep runners |
| FULL_EXIT | "Sell all", "done for the day" | SELL ALL remaining contracts |

### Entry and Exit Rules

**Entry:**
- Flat $2,000 budget per trade
- Limit order at 1.5x the guru's signal price
- Max 500 contracts per order
- One position per day -- subsequent entries treated as SCALE_IN
- Pre-market signals queued until 6:30 AM, cancelled after 7:00 AM

**Exit (guru-driven):**
- PARTIAL_EXIT: sell half, keep runners. Second partial = sell all remaining.
- FULL_EXIT: sell everything.

**Exit (automated -- only one):**
- 12:40 PM PST force close. No trailing stops, no hard stops, no time-based exits.

### Polling Zones

| Zone | Hours (PST) | Discord Poll Rate | Position Update Rate |
|------|-------------|-------------------|---------------------|
| Hot | 6:25 - 7:45 AM | Every 3 seconds | Every 5 minutes |
| Cruise | 7:45 AM - 12:40 PM | Every 10 seconds | Every 15 minutes |
| Off | All other times + weekends | Every 60 seconds | Every 30 minutes |

### Safety Mechanisms

These were added after a $19,807 paper loss on March 4, 2026:

| Mechanism | What It Prevents |
|-----------|-----------------|
| Typed API errors (`AlpacaError`) | Transient 5xx/429 errors being treated as "position closed" |
| Triple-confirm position removal | Single API hiccup wiping position from state |
| 60-second reconciliation | State drift from reality (orphaned positions, stale entries) |
| Order fill verification | Recording guru's signal price instead of actual fill price |
| PM2 auto-restart | Daemon death killing the 12:40 PM EOD close |
| Pre-market entry queue | Entry signals rejected before options market opens |
| Sell order retry (3x + pending) | Failed sells never retried |
| Discord health alerting | Silent Discord API failures going unnoticed |

### Risk Profile

- Only buys options (defined risk). Never sells naked options, never shorts.
- Maximum loss per trade = $2,000 (the premium paid).
- Winning days (~80%): +100% to +2000% on $2,000.
- Losing days (~20%): up to -$2,000.

> Detailed documentation: [DOCS.md](DOCS.md), [STRATEGY.md](STRATEGY.md), [SYSTEM.md](SYSTEM.md)

---

## 3. System 2: BTC 5-Minute Trader

### What It Does

Discovers Polymarket BTC up/down prediction markets every 5 minutes, runs an ensemble of quantitative strategies to predict whether BTC will be higher or lower at the end of the window, and executes trades through a configurable adapter (Polymarket, Alpaca Crypto, or dry-run simulation).

### How Polymarket BTC 5-Minute Markets Work

Polymarket offers binary prediction markets on whether BTC's price will go **up** or **down** within a 5-minute window. Each window has:

- A **slug** like `btc-updown-5m-1741651200` (derived from the epoch timestamp)
- Two tokens: **Up** and **Down**, each priced between $0.01 and $0.99
- The winning token pays $1.00 at resolution; the losing token pays $0.00
- Markets resolve automatically based on BTC's actual price movement

If you buy an "Up" token at $0.55 and BTC goes up, you get $1.00 back (profit = $0.45 minus fees). If BTC goes down, you lose the $0.55.

### Architecture

```
Data Sources                         Processing                      Execution
+------------------+
| Binance WebSocket |---+
| (BTC/USDT ticks)  |   |
+------------------+    |     +-----------------+     +------------------+
                        +---->| Feature Vector  |---->| Ensemble Strategy|
+------------------+    |     | Builder         |     | (6 sub-strategies|
| Polymarket Gamma |----+     |                 |     |  weighted voting)|
| API (5-min       |    |     | 22 features:    |     +--------+---------+
|  windows)        |    |     | - BTC returns   |              |
+------------------+    |     | - volatility    |     +--------v---------+
                        +---->| - momentum      |     | Positive EV?     |
+------------------+    |     | - orderbook     |     | (fees included)  |
| Polymarket CLOB  |----+     | - sentiment     |     +--------+---------+
| (orderbooks)     |         | - time features |              |
+------------------+         +-----------------+     +--------v---------+
                                                      | Execution Adapter|
+------------------+                                  |                  |
| News RSS + Reddit|---+                              | - Polymarket CLI |
| + X/Twitter via  |   |                              | - Alpaca Crypto  |
|   Grok           |---+                              | - Dry Run (sim)  |
+------------------+                                  +------------------+
```

### Main Loop

The daemon (`src/btc-trader/index.ts`) runs a tick function every 5 seconds:

1. **Compute epoch** -- determine which 5-minute window we're in (Unix timestamp rounded to 300s).
2. **Check timing** -- evaluate only at checkpoints 75s, 150s, and 220s into the window (three chances per window).
3. **One trade per window** -- if `lastTradeEpoch` matches the current window, skip.
4. **Fetch market** -- call Polymarket Gamma API for the current window's slug, tokens, and implied probabilities.
5. **Fetch orderbooks** -- call Polymarket CLOB API for up/down token order books (8s timeout).
6. **Refresh sentiment** -- fetch news/Reddit headlines + X/Twitter sentiment via Grok (cached 5 minutes).
7. **Build feature vector** -- 22 numeric features from all data sources.
8. **Run ensemble strategy** -- weighted vote across 6 sub-strategies.
9. **Execute if positive EV** -- place order through the configured adapter.
10. **Schedule resolution** -- after window ends, check outcome and compute P&L.

### Data Sources

#### Binance Price Feed (`src/btc-trader/data/binance-ws.ts`)

Connects to `wss://stream.binance.com:9443/ws/btcusdt@trade` via WebSocket. Maintains up to 5,000 ticks in memory. Provides:

- Real-time BTC/USDT price
- 1-minute OHLCV candles (built on-the-fly from raw ticks)
- Period returns (1m, 5m, 15m)
- Volatility calculations
- Auto-reconnect on disconnect (3s delay)

#### Market Clock (`src/btc-trader/clock/market-clock.ts`)

Maps Unix time to 5-minute window epochs. Fetches the corresponding Polymarket market via the Gamma API (`gamma-api.polymarket.com/markets?slug=btc-updown-5m-{epoch}`). Returns the `MarketWindow` with:

- `slug` -- market identifier
- `epochStart` / `epochEnd` -- window boundaries
- `upTokenId` / `downTokenId` -- CLOB token IDs for trading
- `resolved` / `outcome` -- whether the window has settled and which side won

#### Orderbook Data (`src/btc-trader/data/clob-client.ts`)

Fetches depth-of-book snapshots from Polymarket's CLOB API for both up and down tokens. Extracts:

- Bid/ask spreads
- Depth imbalance (ratio of bid volume to ask volume)
- Implied probabilities (midpoint of best bid and ask)

#### Sentiment Feed (`src/btc-trader/data/news-feed.ts`)

Three sources combined:

1. **News RSS** -- CoinDesk, CoinTelegraph, Bitcoin Magazine headlines
2. **Reddit RSS** -- r/bitcoin, r/cryptocurrency, r/bitcoinmarkets hot posts
3. **X/Twitter via Grok** -- Grok has live access to X posts; queries for breaking events, regulatory news, whale movements, and exchange problems

Headlines are analyzed by Grok (`grok-3-mini-fast`) to produce a sentiment score (-1 to +1) and event risk (0 to 1). X/Twitter sentiment is weighted 40%, headlines 60%. The combined score is cached for 5 minutes.

### Feature Vector

The feature vector (`src/btc-trader/features/feature-vector.ts`) contains 22 numeric features:

| Category | Features | Source |
|----------|----------|--------|
| Price | `btcPrice`, `btcReturn1m`, `btcReturn5m`, `btcReturn15m` | Binance ticks/candles |
| Volatility | `btcVolatility1m`, `btcVolatility5m` | Std dev of candle returns |
| Momentum | `btcMomentum` | Weighted average of recent candle directions |
| Orderbook (Up) | `bookBidAskSpreadUp`, `bookDepthImbalanceUp` | CLOB up-token book |
| Orderbook (Down) | `bookBidAskSpreadDown`, `bookDepthImbalanceDown` | CLOB down-token book |
| Market prices | `impliedProbUp`, `impliedProbDown` | Midpoint of CLOB best bid/ask |
| Sentiment | `sentimentScore`, `eventRisk` | News + Reddit + X/Twitter via Grok |
| Time | `secondsIntoWindow`, `hourOfDay`, `dayOfWeek`, `isWeekend` | System clock |
| Window | `windowEpoch`, `timestamp` | Market clock |

### Ensemble Strategy

The ensemble (`src/btc-trader/strategies/ensemble.ts`) runs 6 sub-strategies and aggregates their votes:

#### Sub-Strategy Details

**Early Momentum** (weight: 30%)
- **When:** 45-180 seconds into the window
- **Signal:** BTC has moved >= 0.005% in 1 minute, and the market hasn't fully repriced (implied prob < 0.75)
- **Confidence:** Base 0.52, boosted by return magnitude (up to +0.20), market agreement (+0.08), sentiment alignment (+0.04), and orderbook imbalance (+0.05). Capped at 0.85.
- **Minimum confidence:** 0.56
- **Idea:** Enter when momentum is clear but the prediction market is still catching up.

**Close Snipe** (weight: 25%)
- **When:** 20-180 seconds remaining in the window
- **Signal:** BTC has moved >= 0.008% from window start, outcome is becoming certain
- **Confidence:** Scales with move magnitude (60%) and proximity to window end (40%). Base 0.55.
- **Minimum confidence:** 0.58
- **Idea:** High win rate, small profit per trade. The market can't fully reprice in the final seconds.

**Momentum Orderbook** (weight: 20%)
- **When:** 45-200 seconds into the window
- **Signal:** BTC momentum aligns with orderbook depth imbalance
- **Confidence:** Combination of momentum strength and book imbalance, penalized by high volatility (up to -0.15)
- **Idea:** Orderbook pressure confirms the price direction signal.

**Value Fade** (weight: 15%)
- **When:** Any time in the window
- **Signal:** One side is >= 72% implied probability and the other side is <= 38% (cheap). BTC's actual move is small or reversing.
- **Confidence:** Based on how cheap the contrarian side is and whether the price is mean-reverting
- **Idea:** When the market overreacts to a small move, fade it.

**Arbitrage** (weight: 0%, disabled)
- **Signal:** Combined cost of up + down tokens < $1.00 after fees
- **Disabled because:** The execution layer only supports single-side orders. Re-enable when dual-side execution is added.

**Sentiment Gated** (weight: 10%)
- **Signal:** News/social sentiment provides directional bias. Requires price confirmation. Abstains when event risk > 0.7.
- **Cannot trade alone** -- at least one "hard data" strategy must also vote.
- **Idea:** Sentiment adds conviction to data-driven signals but never initiates trades independently.

#### Aggregation Logic

1. Collect all non-abstaining sub-strategy decisions.
2. Discard if only sentiment-gated voted (requires at least one data-driven strategy).
3. Compute weighted scores: `upScore = sum(weight * confidence)` for up-voters, same for down.
4. Normalize by total active weight.
5. Winning direction = higher normalized score.
6. Ensemble confidence = `winningScore * (0.7 + 0.3 * agreement)` where agreement = fraction of voters agreeing with the winning direction.
7. Reject if ensemble confidence < 0.33.
8. Reject if not positive EV after fees.
9. Kelly sizing: `(edge * odds) * 0.25` (quarter-Kelly for conservative sizing).

### Fee Model

Polymarket charges taker fees on crypto 5-minute markets:

```
fee = feeRate * (price * (1 - price))^2
```

where `feeRate = 0.25`. Peak effective rate is ~1.56% at price $0.50, declining to near 0% at extremes (price near $0.01 or $0.99).

A trade is positive EV when: `modelProbability > marketPrice + (feeRate * marketPrice)`

### Execution Adapters

All adapters implement the `ExecutionAdapter` interface: `placeOrder`, `cancelOrder`, `getBalance`, `getOpenPositions`.

**Polymarket** (`src/btc-trader/execution/polymarket-exec.ts`)
- Uses the `polymarket` CLI tool to place orders on the CLOB
- Requires: CLI installed, wallet configured (`polymarket wallet create`), VPN active (geo-blocked in the US)
- Orders: limit buy at `min(0.99, marketPrice + 0.005)`
- Minimum order size: 5 tokens or enough to exceed $1 total
- Availability check: geo-block test + wallet verification

**Alpaca Crypto** (`src/btc-trader/execution/alpaca-crypto-exec.ts`)
- REST API for BTC/USD spot trading on Alpaca
- "Down" predictions are skipped (no shorting available)
- Uses existing Alpaca API credentials from `.env`

**Dry Run** (`src/btc-trader/execution/dry-run.ts`)
- Simulated execution with a virtual balance (default: 20x budget = $1,000)
- Tracks positions in memory, resolves P&L when window outcome is known
- Deducts realistic fees using the Polymarket fee model
- Default mode (`BTC_DRY_RUN=true`)

### Order Construction

When the ensemble decides to trade:

```
direction:  'up' or 'down' (from ensemble decision)
tokenId:    the corresponding Polymarket token ID
side:       always 'buy' (positions resolve at window end, no selling needed)
price:      min(0.99, marketPrice + 0.005)
size:       budgetPerTrade / marketPrice
```

### Resolution

After a 5-minute window ends (+ 10s buffer), the daemon checks if the market has resolved:

- If resolved: logs the outcome, computes P&L (for dry-run: winning positions pay $1.00 per token; losing positions pay $0.00).
- If not yet resolved: retries every 15 seconds until the Gamma API shows resolution.

### Backtesting

The system includes a backtester (`src/btc-trader/backtest/`) that:

1. Fetches historical BTC candles from Binance (with CoinGecko fallback)
2. Constructs synthetic 5-minute windows
3. Runs each sub-strategy and the ensemble against historical data
4. Computes metrics: win rate, total P&L, profit factor, max drawdown, Sharpe ratio, Brier score

```bash
npm run btc:backtest       # default 7 days
npm run btc:backtest:7d    # explicit 7 days
npm run btc:backtest:1d    # 1 day
```

### Risk Management

| Mechanism | Implementation |
|-----------|---------------|
| Position sizing | Fixed `budgetPerTrade` (default $50). Size = budget / marketPrice. |
| One trade per window | `lastTradeEpoch` prevents duplicate trades in the same 5-min window. |
| Balance check | Skips trade if `available < estimatedCost` (1.05 / marketPrice). |
| Positive EV filter | Every trade must pass `isPositiveEV()` after accounting for fees. |
| Ensemble minimum confidence | Rejects decisions with confidence < 0.33. |
| Sub-strategy minimum confidence | Each strategy has its own threshold (0.56 to 0.58). |
| Kelly sizing | Quarter-Kelly (0.25x) for conservative position sizing. |
| Event risk gate | Sentiment-gated strategy abstains when `eventRisk > 0.7`. |
| Volatility penalty | Momentum-orderbook reduces confidence by up to 0.15 in high vol. |
| Geo-block detection | Falls back to dry-run if Polymarket is geo-blocked. |
| Dry-run default | `BTC_DRY_RUN=true` by default -- no real money until explicitly enabled. |

### State Management

**Trading state** (`state/btc-trading-state.json`):

```json
{
  "currentWindow": {
    "slug": "btc-updown-5m-1741651200",
    "epochStart": 1741651200,
    "epochEnd": 1741651500,
    "direction": "up",
    "entryPrice": 0.55,
    "size": 90.9,
    "strategy": "ensemble",
    "orderId": "ensemble-btc-updown-5m-1741651200-1741651275000"
  },
  "todayStats": {
    "windowsProcessed": 45,
    "windowsTraded": 8,
    "totalPnl": 12.50,
    "wins": 5,
    "losses": 3,
    "lastTradeTime": "2026-03-10T18:30:00Z"
  },
  "cumulativeStats": {
    "totalWindows": 500,
    "totalTrades": 80,
    "totalPnl": 125.00,
    "wins": 48,
    "losses": 32,
    "winRate": 0.6,
    "startDate": "2026-03-01T00:00:00Z"
  },
  "balance": 1125.00,
  "lastHeartbeat": "2026-03-10T18:31:00Z",
  "executionAdapter": "dry-run",
  "dryRun": true
}
```

**Health snapshot** (`state/btc-system-health.json`): Written every 60 seconds with daemon status, adapter name, BTC price, connection status, and today's stats.

**Cycle log** (`logs/btc-cycles.jsonl`): Append-only JSONL file with one entry per evaluated window -- decisions, trades, features, and outcomes.

**Daily reset**: At midnight UTC, today's stats are reset and a daily summary notification is sent.

---

## 4. Shared Infrastructure

### Logging

Two independent Winston loggers:

| System | Info Log | Error Log | Format |
|--------|----------|-----------|--------|
| Discord Guru | `trades.log` | `error.log` | `[timestamp] LEVEL: message` |
| BTC Trader | `logs/btc-trader.log` | `logs/btc-trader-error.log` | `[timestamp] BTC-TRADER LEVEL: message` |

Both log to console simultaneously.

### Notifications

Both systems send notifications via Discord webhook (primary) with `[NOTIFY]` stdout as fallback.

**BTC Trader notifications:**
- System start/stop
- Trade decisions (direction, confidence, strategy reasoning)
- Trade results (filled/failed, price, size)
- Window resolution (outcome, P&L)
- Daily summary (wins, losses, total P&L)
- Errors and warnings

### Process Management

**Discord Trader** runs under PM2 via `ecosystem.config.js`:
- Auto-restart on crash (max 50 restarts, 5s delay)
- Memory limit: 500MB
- Logs: `logs/pm2-out.log`, `logs/pm2-error.log`

**BTC Trader** manages its own singleton via PID file (`state/btc-trader.pid`):
- On startup, kills any previous instance with the same PID file
- Graceful shutdown on SIGINT/SIGTERM

### Configuration

All configuration is via environment variables loaded from `.env`:

#### Discord Guru-Follow

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `DISCORD_USER_TOKEN` | Yes | -- | Discord user token for REST API |
| `DISCORD_CHANNEL_ID` | Yes | -- | Channel to monitor |
| `DISCORD_AUTHOR_NAME` | No | Stocksandrealestate | Filter by guru name |
| `ALPACA_API_KEY` | Yes | -- | Alpaca API key |
| `ALPACA_API_SECRET` | Yes | -- | Alpaca API secret |
| `ALPACA_BASE_URL` | No | paper-api.alpaca.markets | Alpaca endpoint |
| `ANTHROPIC_API_KEY` | No | -- | Claude LLM classifier |
| `GROK_API_KEY` | No | -- | Grok fallback classifier |
| `DISCORD_WEBHOOK_URL` | No | -- | Notification webhook |
| `LLM_CLASSIFIER_ENABLED` | No | true | Enable LLM classification |
| `LLM_CLASSIFIER_TIMEOUT_MS` | No | 5000 | LLM timeout |
| `LOG_LEVEL` | No | info | Winston log level |

#### BTC 5-Minute Trader

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `POLYMARKET_PRIVATE_KEY` | No | -- | Polymarket wallet key |
| `BTC_BUDGET_PER_TRADE` | No | 50 | Dollars per trade |
| `BTC_MIN_CONFIDENCE` | No | 0.60 | Config-level min confidence |
| `BTC_MAX_POSITIONS_PER_HOUR` | No | 12 | Max trades per hour |
| `BTC_DRY_RUN` | No | true | Simulate trades |
| `BTC_EXECUTION_ADAPTER` | No | dry-run | `dry-run`, `polymarket`, or `alpaca` |
| `GROK_API_KEY` | No | -- | Sentiment analysis via Grok |
| `DISCORD_WEBHOOK_URL` | No | -- | Notification webhook |

---

## 5. Operational Guide

### Prerequisites

- Node.js v18+
- npm
- PM2 (`npm install -g pm2`) -- for Discord Guru daemon
- Alpaca trading account with options enabled (Level 3) -- for Discord Guru
- Discord account with access to guru's server -- for Discord Guru
- Polymarket CLI (`npm install -g @polymarket/cli`) -- for live BTC trading
- VPN (Brazil recommended) -- Polymarket is geo-blocked in the US

### Initial Setup

```bash
git clone <repo-url> btc-trader
cd btc-trader
npm install
cp .env.example .env
# Edit .env with your credentials
```

### Discord Guru-Follow Commands

```bash
# Daemon (PM2-managed, auto-restarts)
npm run daemon:start          # Start
npm run daemon:stop           # Stop
npm run daemon:restart        # Restart
npm run daemon:logs           # View last 100 lines
npm run daemon:status         # PM2 process status
npm run daemon:clean-start    # Kill zombies, cancel orders, start fresh

# CLI
npx tsx src/index.ts portfolio   # Account balance and positions
npx tsx src/index.ts state       # Current trading state
npx tsx src/index.ts close-all   # Force close all positions
npx tsx src/index.ts reset       # Reset state for new day

# Development
npm run dev                      # tsx watch (auto-reload, no PM2)

# Testing
npm run test:preflight           # 8-check preflight suite
npm run test:simulate            # Full day simulation
```

### BTC 5-Minute Trader Commands

```bash
# Daemon
npm run btc:start                # Start BTC trader daemon

# Status
npm run btc:status               # Print btc-trading-state.json

# Backtesting
npm run btc:backtest             # 7-day backtest (default)
npm run btc:backtest:7d          # Explicit 7-day backtest
npm run btc:backtest:1d          # 1-day backtest
```

### Streamer (Optional Backup)

```bash
cd streamer
npm install
npm start                        # Alpaca OPRA WebSocket, backup 12:40 PM close
```

---

## 6. File Structure

```
btc-trader/
|-- DOCS.md                          # Detailed Discord Guru documentation
|-- STRATEGY.md                      # Trading philosophy and rules
|-- SYSTEM.md                        # Discord Guru architecture reference
|-- HOW-IT-WORKS.md                  # This file (unified documentation)
|-- ecosystem.config.js              # PM2 config (Discord Guru daemon)
|-- package.json                     # Dependencies and scripts
|-- tsconfig.json                    # TypeScript config (ES2022, CommonJS)
|-- .env                             # Environment variables (not in git)
|-- .env.example                     # Template for .env
|
|-- src/
|   |-- index.ts                     # Discord Guru entry point (daemon + CLI)
|   |-- config.ts                    # Discord Guru configuration
|   |-- alpaca/
|   |   +-- client.ts                # Alpaca REST client (typed errors)
|   |-- discord/
|   |   +-- monitor.ts               # Adaptive Discord polling
|   |-- parser/
|   |   |-- llm-classifier.ts        # Claude/Grok LLM classification
|   |   |-- message-classifier.ts    # LLM + regex pipeline
|   |   |-- signal-parser.ts         # Ticker/strike/price extraction
|   |   +-- types.ts                 # TradeSignal type definition
|   |-- trading/
|   |   +-- guru-trade-manager.ts    # Trade lifecycle and state management
|   |-- notifications/
|   |   +-- notifier.ts              # Discord webhook + stdout notifications
|   |-- utils/
|   |   |-- find-channel.ts          # Discord channel lookup helper
|   |   +-- logger.ts                # Winston logging setup
|   |-- test/
|   |   |-- preflight.ts             # 8-check preflight test suite
|   |   |-- simulate-day.ts          # Full day simulation test
|   |   |-- test-discord-history.ts
|   |   +-- test-llm-providers.ts    # LLM provider connectivity tests
|   |
|   +-- btc-trader/
|       |-- index.ts                 # BTC Trader entry point (daemon + CLI)
|       |-- config.ts                # BTC Trader configuration
|       |-- types.ts                 # All BTC Trader type definitions
|       |-- clock/
|       |   |-- market-clock.ts      # 5-min window epoch mapping + Gamma API
|       |   +-- logger.ts            # BTC Trader Winston logger
|       |-- data/
|       |   |-- binance-ws.ts        # Binance BTC/USDT WebSocket price feed
|       |   |-- gamma-client.ts      # Polymarket Gamma API (geo-check)
|       |   |-- clob-client.ts       # Polymarket CLOB orderbook fetcher
|       |   |-- news-feed.ts         # RSS + Reddit + X/Twitter sentiment
|       |   +-- historical.ts        # Historical candle fetcher for backtests
|       |-- features/
|       |   |-- feature-vector.ts    # 22-feature vector builder
|       |   |-- price-features.ts    # Returns, volatility, momentum helpers
|       |   |-- orderbook-features.ts# Spread, depth imbalance, implied prob
|       |   +-- fees.ts              # Polymarket fee model and EV calculations
|       |-- strategies/
|       |   |-- strategy-interface.ts# Strategy interface + abstain helper
|       |   |-- ensemble.ts          # Ensemble: weighted voting + Kelly sizing
|       |   |-- early-momentum.ts    # Early window momentum entry
|       |   |-- close-snipe.ts       # Late window snipe entry
|       |   |-- momentum-orderbook.ts# Momentum + orderbook confirmation
|       |   |-- value-fade.ts        # Mean reversion on overpriced markets
|       |   |-- arbitrage.ts         # Cross-side arbitrage (disabled)
|       |   +-- sentiment-gated.ts   # Sentiment filter (cannot trade alone)
|       |-- execution/
|       |   |-- execution-adapter.ts # ExecutionAdapter interface
|       |   |-- dry-run.ts           # Simulated execution with virtual balance
|       |   |-- polymarket-exec.ts   # Polymarket CLI order placement
|       |   +-- alpaca-crypto-exec.ts# Alpaca BTC/USD spot trading
|       |-- state/
|       |   +-- trading-state.ts     # State read/write, health, cycle logs
|       |-- notifications/
|       |   +-- notifier.ts          # BTC Trader Discord webhook notifications
|       +-- backtest/
|           |-- run-backtest.ts      # Backtest entry point
|           |-- backtest-runner.ts   # Strategy backtesting engine
|           +-- metrics.ts           # Win rate, Sharpe, drawdown calculations
|
|-- streamer/
|   |-- index.js                     # Alpaca OPRA WebSocket (backup EOD close)
|   |-- package.json                 # Streamer dependencies (ws, msgpack-lite)
|   |-- README.md                    # Streamer documentation
|   +-- start.sh                     # Launch script
|
|-- scripts/
|   +-- clean-start.sh               # Kill zombies, cancel orders, start fresh
|
|-- state/                           # Runtime state (not in git)
|   |-- trading-state.json           # Discord Guru live state
|   |-- btc-trading-state.json       # BTC Trader live state
|   |-- system-health.json           # Discord Guru health snapshot
|   |-- btc-system-health.json       # BTC Trader health snapshot
|   +-- trading-state.example.json   # State file template
|
|-- logs/                            # All logs (not in git)
|   |-- pm2-out.log                  # PM2 stdout
|   |-- pm2-error.log                # PM2 stderr
|   |-- trades.log                   # Discord Guru info log
|   |-- error.log                    # Discord Guru error log
|   |-- btc-trader.log               # BTC Trader info log
|   |-- btc-trader-error.log         # BTC Trader error log
|   |-- btc-cycles.jsonl             # BTC Trader window cycle audit log
|   +-- classifications.jsonl        # LLM classification audit log
|
|-- memory/                          # Daily notes by OpenClaw (not in git)
|   +-- YYYY-MM-DD.md
|
+-- openclaw/                        # OpenClaw AI assistant config
    |-- AGENTS.md                    # Operating instructions
    |-- DAILY-START.md               # Copy-paste daily startup prompt
    |-- MEMORY.md                    # Long-term system facts
    |-- README.md                    # OpenClaw setup instructions
    +-- SOUL.md                      # Persona and tone
```
