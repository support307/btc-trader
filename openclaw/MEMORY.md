# MEMORY.md -- Trading Systems

## System Overview

I manage two independent trading systems at `~/projects/discord-trader`:

1. **Discord Guru-Follow** -- monitors a Discord guru and executes 0DTE options on Alpaca
2. **BTC 5-Minute Trader** -- autonomous Polymarket bets on Bitcoin direction every 5 minutes

---

## SYSTEM 1: Discord Guru-Follow

### Overview

Monitors a Discord guru called **Stocksandrealestate** in the **#private-alerts** channel and automatically executes trades on Alpaca based on his signals.

## Account

- Broker: Alpaca (paper trading mode)
- Endpoint: `https://paper-api.alpaca.markets`
- Approximate equity: $30,000-$50,000
- Budget per trade: flat $2,000 (fixed, not a percentage of equity)
- Asset class: 0DTE options on SPY, IWM (calls or puts)

## Guru Pattern (All Times PST)

- ~6:00-6:10 AM: Posts gameplan with tickers and direction
- ~6:25-6:35 AM: Entry signal with specific strike + price
- ~6:35-6:50 AM: May mention scale-in ("Adding here", "better fill") — we do NOT buy more, one buy per day only
- ~7:00-7:30 AM: On winning days, calls profit ("sell half", "cooking")
- ~7:30 AM-12:00 PM: Additional updates or second exit signals
- Typical entries: IWM $0.10-$0.20, SPY $0.30-$0.50

## One Buy, One Sell Per Day (CRITICAL)

The system enforces strict one-buy-one-sell:
- `boughtToday` flag in trading state prevents any second buy
- Scale-in signals from guru are logged but NEVER executed
- After exiting, `closedToday` prevents re-entry
- This means max risk per day is always $2,000

## Exit Rules (CRITICAL -- Never Override)

1. **Guru says "sell half"** -- sell half the position, keep runners
2. **Guru says "sell all" / "done for the day"** -- sell everything
3. **12:40 PM PST** -- force close all remaining (0DTE expiry protection)

There are NO other exits. No hard stops. No trailing stops. No daily loss limits. No time-based exits. If the option drops to $0.01, we hold until the guru calls it or 12:40 PM. The winning days (100-2000% gains) far outweigh the losing days (max $2,000 loss).

## Notifications

- Primary: Discord webhook (Spidey Bot) -- posts color-coded embeds to a private channel
- Fallback: `[NOTIFY]` stdout lines for OpenClaw to pick up
- Updates sent: gameplan, entry confirmation, guru messages, periodic P&L (5min/15min), milestones (+50%, +100%, +200%, -25%, -50%), exits

## Daemon Commands

- **Clean start (ALWAYS use this)**: `cd ~/projects/discord-trader && npm run daemon:clean-start` — kills zombies, cancels orders, starts fresh
- Start: `cd ~/projects/discord-trader && npm run daemon:start` (PM2 managed, auto-restarts)
- Stop: `npm run daemon:stop`
- Restart: `npm run daemon:restart`
- Logs: `npm run daemon:logs`
- Status: `npm run daemon:status`
- Dev mode: `npm run dev` (tsx watch, no auto-restart)
- **Daily startup prompt**: see `openclaw/DAILY-START.md` for the copy-paste message

## CLI Commands

- Portfolio: `cd ~/projects/discord-trader && npx tsx src/index.ts portfolio`
- State: `npx tsx src/index.ts state`
- Force close: `npx tsx src/index.ts close-all`
- Reset for new day: `npx tsx src/index.ts reset`
- Run simulation test: `npm run test:simulate`

## Documentation

- Full system docs: `~/projects/discord-trader/SYSTEM.md`
- Trading strategy: `~/projects/discord-trader/STRATEGY.md`

## LLM Classifier (Updated Mar 10, 2026)

The system uses a dual-provider LLM setup with automatic failover:

**Provider chain: Anthropic (Claude) → Grok (xAI) → Regex**

1. **Anthropic (primary)**: Claude Sonnet -- best at nuanced sell signals and image interpretation. Supports text + image classification.
2. **Grok (failover)**: xAI's `grok-3-mini-fast` for text, `grok-4-1-fast-non-reasoning` for images. Activates automatically if Anthropic fails (401, timeout, rate limit).
3. **Regex (last resort)**: Pattern matching. Always works but cannot read images or handle ambiguity.

Both LLM providers can:
- Read the guru's text AND image attachments (P&L screenshots, charts)
- Understand context and ambiguity ("to be safe" in a sell context vs. general commentary)
- Handle novel message formats the guru hasn't used before
- Return structured JSON with confidence scores
- Use a sliding window of the last 10 messages for context-aware classification

The classification audit log records which provider handled each message (`anthropic`, `grok`, or `regex`). If you see all messages falling to regex, check both API keys. Requires `ANTHROPIC_API_KEY` and `GROK_API_KEY` in `.env`.

**Testing providers**: `npx tsx src/test/test-llm-providers.ts` tests both providers with text + images.

## Observability Files

- **Classification audit log**: `~/projects/discord-trader/logs/classifications.jsonl` -- every guru message classification is logged with timestamp, raw text, type, confidence, reasoning, and whether it was LLM or regex. Use this for post-day review and spotting misclassifications.
- **System health file**: `~/projects/discord-trader/state/system-health.json` -- updated every 60s by the daemon. Contains: daemon start time, last heartbeat, zone, position count, LLM status, classification counters, and last classification details. If `lastHeartbeat` is stale (>3 min), the daemon may be down.

## Safety Mechanisms (Added Mar 5, 2026)

- LLM classifier with regex fallback (never silently misclassifies)
- Conversation context window (last 10 messages) for better LLM disambiguation
- Classification audit log for post-day review and OpenClaw oversight
- System health file updated every 60s for quick daemon status checks
- Typed API errors distinguish 404 from transient failures
- Position removal requires 3 consecutive confirmed 404s (not just one API hiccup)
- Alpaca reconciliation every 60s syncs local state with actual broker positions
- Order fill verification polls for up to 10s and records actual fill price
- PM2 auto-restarts daemon on crash; startup reconciles with Alpaca
- Pre-market entry queue: if guru signals before market open, auto-retries when market opens
- Sell retry: 3 immediate attempts + ongoing retry every 10s via safety check
- Discord health alerting: warns on 5 consecutive poll failures or 30min silence in hot zone

## Lessons Learned

- Feb 17-Mar 3: Autonomous exits (trailing stops, time-based, "adding=danger") caused 3 consecutive losses
- Mar 4: Overhauled to guru-follow mode, removed all autonomous exits
- Mar 4 paper trade: Transient API error wiped position from state, missed +120% sell signal, lost $19k paper. Fixed with typed errors, triple-confirm removal, reconciliation, Discord webhook, PM2.
- The guru's plays need time and room. Never override him.

---

## SYSTEM 2: BTC 5-Minute Trader

### Overview

Fully autonomous bot that trades on Polymarket's "Bitcoin Up or Down" 5-minute markets. Every 5 minutes, a new market opens asking whether BTC will be higher or lower at the end of the window. The bot analyzes price data, orderbook, and sentiment to decide UP, DOWN, or ABSTAIN, then places a trade if confident.

The code lives at `~/projects/discord-trader/src/btc-trader/`. The entry point is `src/btc-trader/index.ts`.

### Polymarket Account

- Wallet address: `0xE8BDf64bBCB4d77462E15083E17223bb6eEF875B`
- Wallet type: Magic.Link proxy wallet (signature_type: "proxy")
- Private key is in `.env` as `POLYMARKET_PRIVATE_KEY` and in `~/.config/polymarket/config.json`
- Chain: Polygon (chain_id 137)
- Currency: USDC.e

### Trading Parameters

- Budget target: $1 per trade (set via `BTC_BUDGET_PER_TRADE=1`)
- Polymarket minimum: 5 tokens AND >$1 total value
- Actual cost per trade: ~$2.50-3.50 (5 tokens at market price)
- Minimum confidence: 60% (set via `BTC_MIN_CONFIDENCE=0.60`)
- Max positions per hour: 12 (one per 5-minute window)
- Execution adapter: Polymarket (live, not dry-run)

### Strategy: Ensemble

The bot runs 5 sub-strategies and combines them with weighted voting:

| Strategy | Weight | What It Does |
|----------|--------|-------------|
| early-momentum | 0.35 | Enters 45-180s into window when market hasn't fully repriced BTC movement |
| close-snipe | 0.25 | Late-window entry when BTC has moved significantly (>0.008%) |
| momentum-orderbook | 0.20 | Combines BTC momentum with Polymarket orderbook imbalance |
| sentiment-gated | 0.15 | Uses X/Twitter and news sentiment as trade filter |
| arbitrage | 0.05 | Seeks UP+DOWN pricing below 1.00 after fees |

Decision timing: the bot evaluates at 75 seconds into each 5-minute window, giving strategies time to detect an edge before the market fully reprices.

### Data Sources

- **Binance WebSocket**: Real-time BTC/USDT price (primary signal)
- **Polymarket CLOB API**: Orderbook depth, market odds, price history
- **Polymarket Gamma API**: Market discovery (finds current 5-min window market)
- **xAI Grok** (`GROK_API_KEY`): X/Twitter sentiment analysis from crypto influencers
- **RSS feeds**: CoinDesk, CoinTelegraph, Bitcoin Magazine, Reddit (news sentiment)

### Critical Limitation: Cannot Auto-Claim Winnings

The Polymarket CLI's `ctf redeem` command does NOT work with Magic.Link proxy wallets. The bot detects redeemable positions and logs a notification, but **cannot execute the claim**. The user MUST manually claim winnings at https://polymarket.com/portfolio by clicking "Claim".

When you see redeemable positions or low balance warnings, always remind the user to claim.

### VPN Requirement

Polymarket is geo-blocked in the US. NordVPN must be connected to **Brazil** before starting the bot. If the bot logs a geo-block warning at startup, the VPN is not connected or is set to a blocked region.

### Process Management

- **PID file**: `state/btc-trader.pid` -- written at startup, checked on restart
- On startup, the bot reads the PID file and kills any previous instance before starting
- On shutdown (SIGINT/SIGTERM), the PID file is cleaned up
- This prevents zombie processes (previously a major issue that drained the account)

### State and Health Files

- **Trading state**: `~/projects/discord-trader/state/btc-trading-state.json` -- current window, positions, daily stats
- **Health file**: `~/projects/discord-trader/state/btc-health.json` -- updated every 60s with tick time, price, balance

### BTC Trader Commands

- **Start**: `cd ~/projects/discord-trader && npm run btc:start`
- **Status**: `npm run btc:status`
- **Backtest 1 day**: `npm run btc:backtest:1d`
- **Backtest 7 days**: `npm run btc:backtest:7d`
- **Stop**: Kill the PID in `state/btc-trader.pid`, or `pkill -f "btc-trader/index.ts"`

### Notifications

Same Discord webhook as the guru system. BTC trades are prefixed with `[BTC-NOTIFY]` in stdout and sent as Discord embeds. Notifications include: startup/shutdown, trade placed, trade result, balance warnings, redeemable positions.

### Lessons Learned (BTC Trader)

- Mar 10: Zombie processes (10+ instances) drained account from $20 to $1. Fixed with PID file management.
- Mar 10: Polymarket CLI cannot redeem proxy wallet positions. Switched to manual-claim notifications.
- Mar 10: Bot needs to enter early in the window (~75s) to find edge. At 220s+ the market has already priced in BTC movement.
- Mar 10: Polymarket minimum order is 5 tokens AND >$1 total. Size calculation must account for both.
- Mar 10: EV calculation had a bug double-complementing down-bet prices. Fixed -- both sides now use token price directly.
