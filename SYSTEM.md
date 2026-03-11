# Discord Signal Auto-Trader -- System Documentation

> This document is the single source of truth for how the guru-follow trading system works. OpenClaw uses this to operate the system, answer user questions, troubleshoot issues, and understand what every notification means. See also STRATEGY.md for trading philosophy and rules.

## Overview

This system follows a Discord guru (Stocksandrealestate) for 0DTE options trades. It:

1. Monitors Discord #private-alerts channel constantly (every 3 seconds during hot zone)
2. Classifies every guru message (GAMEPLAN, ENTRY, SCALE_IN, UPDATE, PARTIAL_EXIT, FULL_EXIT)
3. Executes options trades on Alpaca immediately when the guru signals
4. Holds positions until the guru says to exit -- no autonomous exits
5. Only automated exit: 12:40 PM PST force close (0DTE expiry protection)
6. Sends you Discord webhook updates on every guru message, periodic position snapshots, and milestone alerts

**You cannot owe money.** The system only buys options (defined risk). Maximum loss = the premium paid (flat $2,000 per trade). It never sells naked options or shorts stock.

## How the Monitoring Works

The system is a single long-running Node.js process managed by PM2 (`npm run daemon:start`). PM2 auto-restarts on crashes. There are NO crons. Everything runs inside the daemon via internal timer loops:

| Loop | Interval | What it does |
|------|----------|-------------|
| **Discord poll** | 3s (hot) / 10s (cruise) / 60s (off) | Fetches new messages from Discord REST API, filters by guru author, classifies each message, executes entry/exit trades |
| **Reconciliation** | Every 60s | Syncs local state with actual Alpaca positions. Recovers orphaned positions, cleans stale entries |
| **Safety check** | Every 10s | Checks if it's 12:40 PM PST (force close). Only deletes state positions after 3 consecutive confirmed 404s from Alpaca |
| **Milestone check** | Every 15s | Checks position P&L against milestones (+50%, +100%, +200%, -25%, etc), sends alert on first crossing |
| **Position update** | Every 30s (sends at 5min/15min) | Sends position summary -- every 5 min in hot zone, every 15 min in cruise |
| **Heartbeat** | Every 60s | Logs zone and position count for monitoring |
| **EOD reset** | Every 60s | Checks for 1:00 PM PST, resets state for next trading day |

### Polling Zones (All Times PST)

| Zone | Hours | Discord Poll Rate | Position Update Rate |
|------|-------|-------------------|---------------------|
| **Hot** | 6:25 - 7:45 AM | Every 3 seconds | Every 5 minutes |
| **Cruise** | 7:45 AM - 12:40 PM | Every 10 seconds | Every 15 minutes |
| **Off** | All other times | Every 60 seconds | Every 30 minutes |

The hot zone covers when the guru posts entry signals and first profit calls. The cruise zone covers the rest of the trading day when later exit signals or updates may come.

## Typical Day Walkthrough

Here is exactly what happens on a trading day, message by message:

```
5:50 AM  -- Start the daemon: npm run daemon:start
           PM2 launches process, system checks Alpaca account, reconciles state, begins Discord polling.
           Discord webhook: "Discord Trader (Guru-Follow Mode) online. Exits: guru signal or 12:40 PM only."

6:04 AM  -- Guru posts: "Todays gameplan $SPY... The calls im watching 3/4 $SPY Call at $688, 3/4 $IWM Call at $265"
           Classified: GAMEPLAN
           Webhook: "GAMEPLAN: Guru watching $SPY, $IWM (calls) today"
           Action: Track tickers. No trade yet.

6:25 AM  -- HOT ZONE BEGINS. Discord polling increases to every 3 seconds.

6:30 AM  -- Guru posts: "High IV Watch $IWM Call at $265 @everyone... 3/4 $IWM Call at $265 at 0.18"
           Classified: ENTRY (has ticker + strike + price)
           Action: BUY ~400 contracts of IWM $265 Call at market price. Wait for fill (up to 10s).
           Webhook: "ORDER SUBMITTED: BUY 400x IWM $265 CALL @ ~$0.18 — Order: abc123. Waiting for fill..."
           Webhook: "FILLED: 400x IWM $265 CALL @ $0.21 ($8,400) (signal: $0.18, slippage: +16.7%)"

6:35 AM  -- Position crosses +50% from actual fill price ($0.21).
           Webhook: "MILESTONE UP +50%: IWM $265 Call. Entry: $0.21 | Now: $0.32. Holding for guru exit signal."

6:37 AM  -- Guru posts: "You can get a better fill down here @everyone... 3/4 $IWM Call at $265 at 0.09"
           Classified: SCALE_IN ("better fill" pattern + has price)
           Webhook: "SCALE IN signal (not executing): Guru adding. Holding current position."
           Action: Hold. No sell. No additional buy. One buy per day only.

6:40 AM  -- 5-minute position update.
           Webhook: "POSITION UPDATE: IWM $265 Call
                     Entry: $0.21 | Now: $0.25 | P&L: +$1,600 (+19.0%)
                     Qty: 400 contracts | Half sold: No
                     Time in trade: 10 min | Guru last: 'scale-in: IWM $265 call @ $0.09'"

7:26 AM  -- Guru posts: "What a comeback from $IWM. You can sell half here to be safe @everyone"
           Classified: PARTIAL_EXIT ("sell half" + "to be safe" patterns)
           Action: SELL 200 contracts (half of 400).
           Webhook: "SOLD HALF: 200x IWM $265 CALL — keeping 200 runners. Order: def456"

7:45 AM  -- CRUISE ZONE BEGINS. Polling slows to every 10 seconds. Updates every 15 minutes.

...      -- If guru posts "sell all" or "done for the day": FULL_EXIT, sells remaining.
           If guru goes quiet: hold runners with 15-minute updates.
           Reconciliation runs every 60s to ensure state matches Alpaca.

12:40 PM -- FORCE CLOSE. System sells all remaining positions automatically.
           Webhook: "SAFETY CLOSE (eod-force-close): Sold 200x IWM $265 CALL"

1:00 PM  -- EOD RESET. State file cleared. Ready for tomorrow.
```

### On a Losing Day

The flow is identical, except:
- The position goes red instead of green
- Milestone alerts fire at -25%, -50%, -75% (informational only, no sell)
- The guru may go quiet (no "sell half" signal comes)
- The position stays open until 12:40 PM force close
- You lose the premium paid (max $2,000)
- Discord webhook keeps you informed with periodic updates showing the negative P&L
- If daemon crashes, PM2 auto-restarts it; reconciliation recovers the position

This is by design. The winning days (+100% to +2000%) far outweigh the losing days.

## Architecture

```
PM2 (auto-restart, crash recovery)
  |
  └── Main Daemon Process
        |
        ├── Discord REST API (polling every 3-10s)
        |     └── LLM Classifier (Claude API — understands text + images)
        |           ├── Falls back to regex if LLM unavailable
        |           └── Guru Trade Manager (entry/exit lifecycle)
        |                 ├── Alpaca Trading API (orders with fill verification + retry)
        |                 ├── Pre-market entry queue (auto-retry when market opens)
        |                 ├── Sell retry (3x immediate + pendingSell every 10s)
        |                 └── Reconciliation (state <-> Alpaca sync every 60s)
        |
        ├── Safety Check (12:40 PM EOD close, position existence, pending retries)
        |
        ├── Discord Health Monitor (alerts on 5 consecutive poll failures or 30min silence)
        |
        └── Notifications
              ├── Discord Webhook (primary, with 3x retry)
              └── [NOTIFY] stdout (fallback for OpenClaw)
```

The optional streamer (WebSocket) runs alongside as a backup for 12:40 PM EOD close:

```
Alpaca OPRA WebSocket (real-time option quotes)
        |
   Streamer (reads trading-state.json)
        |
   Backup: 12:40 PM EOD close only
```

The guru-trade-manager executes all entry and exit orders directly via Alpaca API with fill verification (polls order status for up to 10s to confirm fill and record actual fill price). The streamer is a safety net that also checks for 12:40 PM close using real-time price data.

**Why REST polling (not Gateway)?** The Discord server is a paid Whop subscription -- can't add a bot. We use a user token with REST API. 3-second polling provides <3s latency for signal detection, which is adequate since the guru's messages come minutes apart.

## Requirements

### Accounts & APIs
- **Alpaca Trading Account** with options enabled (Level 3)
  - Paper: `https://paper-api.alpaca.markets`
  - Live: `https://api.alpaca.markets`
  - Data: `https://data.alpaca.markets`
- **Anthropic API Key** for Claude LLM classifier (intelligent message understanding + images)
- **Discord Account** with access to the paid server (Whop subscription)
- **Discord Webhook** for receiving trade notifications (primary notification channel)
- **OpenClaw** (optional) for health monitoring, manual overrides, WhatsApp notifications

## Message Classification

The classifier uses a two-tier approach:

1. **Primary: Claude LLM** (`src/parser/llm-classifier.ts`) -- Sends the guru's text + any image attachments to Claude API. Claude understands context, reads P&L screenshots, and handles ambiguous phrasing. Returns a JSON classification with confidence score. Requires `ANTHROPIC_API_KEY` in `.env`.

2. **Fallback: Regex** (`src/parser/message-classifier.ts`) -- If Claude is unavailable (no API key, timeout, rate limit), falls back to regex pattern matching. Priority order matters -- exit signals are checked before entry signals.

The LLM classifier is used when `LLM_CLASSIFIER_ENABLED=true` (default) and an Anthropic API key is set. Timeout is 5 seconds. If LLM confidence is below 70%, it falls back to regex.

### GAMEPLAN
Patterns: "gameplan", "watching", "calls im watching"
Action: Save tickers, send notification. No trade.

### ENTRY
Trigger: Has $TICKER + strike + price (parsed by signal parser, e.g. "$IWM Call at $265 at 0.18")
Action: Buy options at mentioned price. Flat $2,000 budget. Limit order at 1.5x signal price. Waits up to 10s for fill confirmation and records actual fill price.

### SCALE_IN
Patterns: "adding here", "better fill", "adding more"
Action: Hold current position. Never buy more — one buy per day only.

### UPDATE
Patterns: "comeback", "cooking", "pump", "amazing", gain percentages
Action: Notification only. No trade action.

### PARTIAL_EXIT
Patterns: "sell half", "take some off", "take profits", "to be safe"
Action: Sell half of position. Keep runners. If half already sold, sell all remaining.

### FULL_EXIT
Patterns: "sell all", "close all", "done for the day", "get out"
Action: Sell all remaining position.

## Trade Lifecycle

```
GAMEPLAN -> track tickers (no trade)
     |
ENTRY -> BUY at signal price (flat $2,000 budget)
     |
[SCALE_IN -> hold (or optionally add)]
     |
[UPDATE -> notification only]
     |
PARTIAL_EXIT -> sell half, keep runners
     |
FULL_EXIT -> sell all remaining
     |
   or
12:40 PM PST -> force close everything (only automated exit)
```

## Automated Exit

There is exactly ONE automated exit condition:

| Condition | Action |
|-----------|--------|
| 12:40 PM PST | Close everything (0DTE expiry protection) |

No -60% hard stop. No daily loss halt. No trailing stops. No time-based decay exits. No "adding = danger" sells. On losing days, we accept the full loss and close at 12:40 PM. The winning days far outweigh the losers.

## Periodic Updates

The system sends notifications via Discord webhook (primary) and stdout (fallback for OpenClaw):

| Notification | When | Content |
|-------------|------|---------|
| **Guru message** | Every guru message | Classification + raw message + current P&L |
| **Position update** | 5 min (hot) / 15 min (cruise) | Entry price, current price, P&L %, P&L $, qty, half sold, time in trade, last guru message |
| **Milestone alert** | When crossed | +50%, +100%, +200%, +300%, +500%, +1000%, -25%, -50%, -75% |
| **Entry confirmation** | On buy | Qty, symbol, price, total cost, order ID |
| **Exit confirmation** | On sell | Qty, symbol, reason (guru/EOD), order ID |
| **EOD summary** | 1:00 PM | Number of trades closed |

All milestones are informational only -- no sell action is taken.

## State File

`state/trading-state.json` tracks the current trading day:

```json
{
  "todaysGameplan": { "tickers": ["IWM", "SPY"], "direction": "call" },
  "positions": {
    "IWM260304C00265000": {
      "symbol": "IWM260304C00265000",
      "ticker": "IWM",
      "strike": 265,
      "type": "call",
      "expiration": "260304",
      "signalPrice": 0.18,
      "entryPrice": 0.21,
      "qty": 400,
      "entryTime": "2026-03-04T14:30:00Z",
      "halfSold": false,
      "guruMessages": ["entry signal @ $0.18, filled @ $0.21", "update: cooking", "sold half (200x)"],
      "lastMilestone": 100
    }
  },
  "closedToday": [],
  "dayTradesUsed": 0
}
```

`signalPrice` is what the guru mentioned. `entryPrice` is the actual Alpaca fill price (used for all P&L calculations).

The state file is reset at 1:00 PM PST each day.

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DISCORD_USER_TOKEN` | required | Discord user token for REST API |
| `DISCORD_CHANNEL_ID` | required | Channel to monitor |
| `DISCORD_AUTHOR_NAME` | Stocksandrealestate | Filter messages by this author |
| `DISCORD_POLL_INTERVAL_MS` | 3000 | Base poll interval (overridden by adaptive logic) |
| `DISCORD_WEBHOOK_URL` | (optional) | Discord webhook URL for sending trade notifications |
| `ANTHROPIC_API_KEY` | (recommended) | Anthropic API key for Claude LLM classifier |
| `LLM_CLASSIFIER_ENABLED` | true | Enable LLM classification (falls back to regex if false or no key) |
| `LLM_CLASSIFIER_TIMEOUT_MS` | 5000 | Max time to wait for LLM response |
| `ALPACA_API_KEY` | required | Alpaca API key |
| `ALPACA_API_SECRET` | required | Alpaca API secret |
| `ALPACA_BASE_URL` | paper-api | Alpaca trading endpoint |
| `BUDGET_FLAT` | $2,000 | Fixed dollar amount per trade |
| `LOG_LEVEL` | info | Logging level |

## Running

### Daemon Mode (Primary -- use PM2 for auto-restart)

```bash
npm run daemon:start       # Start with PM2 (auto-restarts on crash)
npm run daemon:stop        # Stop the daemon
npm run daemon:restart     # Restart the daemon
npm run daemon:logs        # View logs (last 100 lines)
npm run daemon:status      # Check PM2 process status
```

For development/debugging:

```bash
npm run dev                # Start with tsx watch (no auto-restart)
```

### CLI Commands

```bash
npx tsx src/index.ts portfolio   # Show account + positions
npx tsx src/index.ts state       # Show trading state
npx tsx src/index.ts close-all   # Force close all positions
npx tsx src/index.ts reset       # Reset state for new day
```

### Streamer (Optional Backup)

```bash
cd streamer && npm start
```

Runs alongside the main daemon for real-time option price data via Alpaca OPRA WebSocket. Provides backup 12:40 PM EOD close with sub-second precision.

## File Structure

```
discord-trader/
├── STRATEGY.md              -- Trading strategy and rules
├── SYSTEM.md                -- This file (system documentation)
├── ecosystem.config.js      -- PM2 process manager config (auto-restart)
├── .env.example             -- Environment variable template
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts             -- Main entry point (daemon + CLI)
│   ├── config.ts            -- Environment-based configuration
│   ├── alpaca/
│   │   └── client.ts        -- Alpaca REST client (typed errors, orders, positions)
│   ├── discord/
│   │   └── monitor.ts       -- Adaptive Discord polling (3s/10s/60s)
│   ├── parser/
│   │   ├── llm-classifier.ts     -- Claude LLM classification (text + images)
│   │   ├── message-classifier.ts -- Async classifier: LLM primary, regex fallback
│   │   ├── signal-parser.ts      -- Ticker/strike/price extraction from text
│   │   └── types.ts              -- TradeSignal type definition
│   ├── trading/
│   │   └── guru-trade-manager.ts -- Guru-driven trade lifecycle (buy/sell/state/reconciliation)
│   ├── notifications/
│   │   └── notifier.ts      -- Discord webhook (primary) + [NOTIFY] stdout (fallback)
│   └── utils/
│       └── logger.ts         -- Winston logging to console + file
├── streamer/
│   └── index.js             -- WebSocket options streamer (backup EOD close)
├── logs/                    -- PM2 log output (gitignored)
└── state/
    ├── trading-state.json         -- Live state (not in git)
    └── trading-state.example.json -- Template
```

## Money Safety

The system can NEVER cause you to owe money:
- Only BUYS options (calls/puts) -- `side: 'buy'` in all entry paths
- Only SELLS to close positions you own -- `side: 'sell'` with qty from your tracked position
- Never sells naked/uncovered options
- Never shorts stock
- Maximum loss = premium paid = $2,000 per trade
- 12:40 PM force close prevents accidental exercise of 0DTE options at expiry

## Safety Mechanisms (Added Mar 5, 2026)

These mechanisms prevent the catastrophic state-loss bug that caused a $19k paper loss on Mar 4:

### 1. Typed API Errors
The Alpaca client throws `AlpacaError` with HTTP status codes. The system distinguishes between 404 (position genuinely gone) and transient errors (500, 429 rate limit, network timeout). Transient errors are NEVER treated as "position closed."

### 2. Triple-Confirm Position Removal
Before deleting a position from state, the safety check requires 3 consecutive confirmed 404 responses from Alpaca. A single API hiccup cannot wipe state.

### 3. Alpaca Reconciliation (Every 60s)
Every 60 seconds (and on startup), the system calls `getPositions()` to list ALL Alpaca positions and compares with local state:
- **Orphaned Alpaca position** (on Alpaca but not in state): re-added to state and tracked
- **Stale state position** (in state but not on Alpaca): only removed after 3 consecutive checks
- **Qty mismatch**: synced from Alpaca (handles external partial fills)

### 4. Order Fill Verification
After submitting an order, the system polls Alpaca's order status every 500ms for up to 10s. Records the actual `filled_avg_price` as `entryPrice` (not the guru's signal price). If the order doesn't fill, it's cancelled and the user is notified.

### 5. Discord Webhook Notifications
Primary notification channel is a Discord webhook with 3x retry and exponential backoff. `[NOTIFY]` stdout is kept as a fallback. Color-coded embeds: green for buys, red for errors, blue for updates, orange for exits.

### 6. PM2 Auto-Restart
The daemon runs under PM2 with `autorestart: true`. If it crashes (OOM, unhandled exception, OpenClaw restart), PM2 restarts it within 5 seconds. On startup, it reconciles with Alpaca and notifies if resuming with open positions.

### 7. Pre-Market Entry Queue
If the guru signals entry before options market opens (6:30 AM PST / 9:30 AM ET), the system queues the entry in `state.pendingEntry` and retries every 10 seconds once the market opens. Cancels if past 7:00 AM PST.

### 8. Sell Order Retry
If a guru sell signal (PARTIAL_EXIT or FULL_EXIT) fails, the system retries 3 times with 2s delay. If all attempts fail, it stores `state.pendingSell` and retries every 10 seconds via the safety check loop until it succeeds.

### 9. Discord Health Alerting
If Discord polling fails 5 consecutive times, a webhook alert is sent. During hot zone, if no guru messages for 30 minutes, a silence alert is sent.

## Lessons Learned

### Feb 17, 2026 -- First Live Day (-$5,743)
- Trailing stops were too aggressive -- position was up +82% then gave it all back
- "Adding more" was interpreted as danger, causing premature exits
- 30-minute timeout sold everything before the play had time to work

### Feb 18 - Mar 3, 2026 -- 3 Consecutive Losses
- Autonomous exit logic (trailing stops, time-based sells) exited before guru's calls
- Positions were sold at -30% that later recovered to +200%
- The guru's plays need time and room to breathe

### Mar 4, 2026 -- System Overhaul
- Removed ALL autonomous exits except 12:40 PM EOD close
- Implemented guru-follow mode: only exit on guru's signal or 12:40 PM
- Added message classifier to understand all guru message types
- Increased polling to 3s during hot zone
- Removed -60% hard stop and daily loss halt -- accept full losses on bad days
- Added periodic position updates (5min/15min) and milestone alerts
- Fixed double-sell race condition between main process and streamer

### Mar 4, 2026 -- First Paper Trade Day (-$19,807)
- **Root cause**: A transient Alpaca API error made `getAlpacaPosition()` return null. The safety check interpreted this as "position closed externally" and deleted it from state. When the guru called "sell half" (+120% gain), the system said "no open position" and did nothing. The position then crashed to near zero.
- **Contributing factors**: (1) No notification delivery -- `[NOTIFY]` stdout wasn't reaching WhatsApp via OpenClaw. (2) Daemon died when OpenClaw was restarted, so 12:40 PM EOD close never fired. (3) Entry price stored was guru's signal price, not actual fill price.
- **Fixes applied**: Typed API errors, triple-confirm position removal, 60s reconciliation, order fill verification, Discord webhook notifications, PM2 auto-restart.
