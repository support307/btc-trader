# Discord Trader -- Complete System Documentation

> This document explains every aspect of the discord-trader system from scratch. It is intended for someone with no prior context. All times are in PST unless stated otherwise.

---

## Table of Contents

1. [What This System Does](#1-what-this-system-does)
2. [Architecture Overview](#2-architecture-overview)
3. [The Guru and Trading Strategy](#3-the-guru-and-trading-strategy)
4. [Daily Schedule and Typical Day Walkthrough](#4-daily-schedule-and-typical-day-walkthrough)
5. [Component Deep Dive](#5-component-deep-dive)
6. [Safety Mechanisms](#6-safety-mechanisms)
7. [State Management](#7-state-management)
8. [Configuration and Environment](#8-configuration-and-environment)
9. [How to Run](#9-how-to-run)
10. [OpenClaw Integration](#10-openclaw-integration)
11. [Lessons Learned](#11-lessons-learned)

---

## 1. What This System Does

This is an automated options trading bot. It monitors a private Discord channel where a trading guru (username: **Stocksandrealestate**) posts real-time trade signals for **0DTE (zero days to expiration) options** on tickers like SPY, IWM, and QQQ. When the guru posts an entry signal, the bot buys options on Alpaca. When the guru posts an exit signal, the bot sells. If the guru never posts an exit, the bot force-closes everything at **12:40 PM PST** to avoid accidental exercise at expiry.

**The core loop:**

```
Guru posts in Discord  -->  Bot reads the message  -->  AI classifies it  -->  Bot executes the trade on Alpaca
```

**Risk profile:**

- The system only **buys** options (calls and puts). It never sells naked options, never shorts stock, never uses margin.
- Maximum loss on any single trade = **$2,000** (the premium paid).
- You can never owe money beyond what was invested.
- Winning days routinely return +100% to +2000% on the position. Losing days lose the $2,000 premium. The asymmetry is the edge.

---

## 2. Architecture Overview

### System Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│  PM2 Process Manager (auto-restart on crash, max 50 restarts)       │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  Main Daemon Process (src/index.ts)                           │  │
│  │                                                               │  │
│  │  ┌─────────────────┐    ┌──────────────────────────────────┐  │  │
│  │  │ Discord Monitor  │───>│ Message Classifier               │  │  │
│  │  │ (REST polling    │    │                                  │  │  │
│  │  │  3s/10s/60s)     │    │  1. Claude LLM (primary)        │  │  │
│  │  └─────────────────┘    │  2. Grok LLM (fallback)         │  │  │
│  │                          │  3. Regex patterns (last resort) │  │  │
│  │                          └──────────┬───────────────────────┘  │  │
│  │                                     │                          │  │
│  │                          ┌──────────▼───────────────────────┐  │  │
│  │                          │ Guru Trade Manager               │  │  │
│  │                          │                                  │  │  │
│  │                          │  - Entry: BUY options            │  │  │
│  │                          │  - Partial exit: SELL half       │  │  │
│  │                          │  - Full exit: SELL all           │  │  │
│  │                          │  - State tracking                │  │  │
│  │                          │  - Reconciliation every 60s      │  │  │
│  │                          └──────────┬───────────────────────┘  │  │
│  │                                     │                          │  │
│  │                          ┌──────────▼───────────────────────┐  │  │
│  │                          │ Alpaca Trading API               │  │  │
│  │                          │ (orders, positions, account)     │  │  │
│  │                          └──────────────────────────────────┘  │  │
│  │                                                               │  │
│  │  ┌─────────────────┐    ┌──────────────────────────────────┐  │  │
│  │  │ Safety Checks    │    │ Notifier                         │  │  │
│  │  │ (every 10s)      │    │ - Discord webhook (primary)     │  │  │
│  │  │ - 12:40 PM close │    │ - stdout [NOTIFY] (fallback)    │  │  │
│  │  │ - pending retries│    └──────────────────────────────────┘  │  │
│  │  │ - position checks│                                         │  │
│  │  └─────────────────┘                                          │  │
│  └───────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────┐
│  Streamer (optional backup)              │
│  - Alpaca OPRA WebSocket                 │
│  - Reads trading-state.json              │
│  - Backup 12:40 PM EOD close             │
└──────────────────────────────────────────┘
```

### Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Runtime | Node.js + TypeScript | Main application |
| Process manager | PM2 | Auto-restart, crash recovery, logging |
| Broker | Alpaca Trading API | Options orders, positions, account data |
| Signal source | Discord REST API | Polling guru's messages (user token, not a bot) |
| AI classification | Anthropic Claude API | Primary message understanding (text + images) |
| AI fallback | xAI Grok API | Secondary classifier when Claude fails |
| Pattern matching | Regex | Last-resort classifier when both LLMs fail |
| Notifications | Discord Webhooks | Trade alerts, position updates, milestones |
| Real-time data | Alpaca OPRA WebSocket | Backup streamer for EOD close |
| State | JSON files on disk | No database -- `state/trading-state.json` |
| Logging | Winston | Console + file logging with levels |

### Why REST Polling Instead of a Discord Bot?

The Discord server is a paid subscription (via Whop). You cannot add a bot to it. The system uses a Discord user token with the REST API. Polling every 3 seconds during the hot zone provides sub-3-second latency for signal detection, which is more than adequate since the guru's messages come minutes apart.

---

## 3. The Guru and Trading Strategy

### Who Is the Guru?

**Stocksandrealestate** is a trader in a paid Discord community. He posts daily trade signals for 0DTE options (options that expire the same day they're traded). His typical instruments are SPY, IWM, and QQQ calls and puts, usually priced between $0.05 and $0.50 per contract.

### The Guru's Typical Pattern

| Time (PST) | What the Guru Does |
|------------|-------------------|
| 6:00 - 6:10 AM | Posts a **gameplan**: tickers, direction (calls/puts), price ranges he's watching |
| 6:25 - 6:35 AM | Posts an **entry signal** with a specific ticker, strike price, and entry price |
| 6:35 - 6:50 AM | May post **scale-in** messages ("Adding here", "better fill") at the same or different strikes |
| 7:00 - 7:30 AM | On winning days: posts a **profit call** ("sell half", "X% gain", "cooking") |
| 7:30 AM - 12:00 PM | Additional updates, second exit signals, or silence |

Typical entries: IWM options at $0.10-$0.20, SPY options at $0.30-$0.50.

### Message Classification

Every guru message is classified into exactly one of six types:

| Type | Example Messages | What the Bot Does |
|------|-----------------|-------------------|
| **GAMEPLAN** | "Todays gameplan $SPY", "The calls im watching" | Track tickers. Send notification. **No trade.** |
| **ENTRY** | "$IWM Call at $265 at 0.09" (has ticker + strike + price) | **BUY** options at the mentioned price |
| **SCALE_IN** | "Adding here", "better fill" + price | **Hold.** Never buy more -- one buy per day only |
| **UPDATE** | "Decent pump", "Absolutely cooking", "250% gain" | Send notification only. **No trade action.** |
| **PARTIAL_EXIT** | "Sell half", "take some off", "to be safe" | **SELL HALF** the position, keep runners |
| **FULL_EXIT** | "Sell all", "close all", "done for the day" | **SELL ALL** remaining contracts |

### Why We Follow Exactly

Previous versions of this system had autonomous exit logic: trailing stops at +50%, time-based decay exits, "adding = danger" sells, and -60% hard stops. This caused **3 consecutive losing days** because the system exited positions before the guru's plays could run. On winning days, the guru's trades routinely dip before running +100% to +250%. Automated exits killed those runners.

The current system has exactly **one** automated exit: **12:40 PM PST force close** (0DTE expiry protection). Everything else follows the guru's signals.

### Entry Rules

- Buy immediately when an ENTRY signal is detected
- Budget: **flat $2,000 per trade** (fixed, regardless of account size)
- Limit order at **1.5x the signal price** (to account for price movement, but reject clearly wrong fills)
- Max 500 contracts per order
- **One position per day** -- if already in a trade, subsequent entries are treated as SCALE_IN (hold, don't buy)
- If the guru signals entry before options market opens (6:30 AM PST), the system queues the entry and retries when the market opens

### Exit Rules

**Guru-driven exits (primary):**

1. **PARTIAL_EXIT** ("sell half") -- sell half, keep runners
2. **Second PARTIAL_EXIT** -- if half already sold, sell all remaining
3. **FULL_EXIT** ("sell all") -- sell everything

**Automated exit (only one):**

| Condition | Action |
|-----------|--------|
| 12:40 PM PST | Force close everything (0DTE expiry protection) |

### What We Explicitly Do NOT Do

- **No hard percentage stops** -- the guru's trades dip before they run
- **No daily loss halts** -- one bad day is worth accepting for the winning days
- **No trailing stops** -- the guru's plays involve holding through drawdowns
- **No time-based exits** -- trades can take 30-60+ minutes to play out
- **No "adding = danger" sells** -- on winning days, "adding" precedes the big move
- **No evaluation scoring** -- we trust the guru's signal, period

### Position Sizing

- Flat **$2,000** per trade
- At $0.15/contract = ~133 contracts; at $0.25/contract = ~80 contracts
- Each contract represents 100 shares of the underlying, so dollar amounts in Alpaca = qty x 100 x option price
- Max loss per trade = $2,000 (the premium paid)

### Expected Value

| Scenario | Frequency | Outcome |
|----------|-----------|---------|
| Winning day | ~80% | Enter at $0.10-$0.20, exit at $0.50-$2.00+ = **+100% to +2000%** on $2,000 |
| Losing day | ~20% | Enter at $0.10-$0.20, option goes to near zero, sell at 12:40 PM = **up to -$2,000** |

Rough expected value per day: `0.8 × $2,000 × 1.5 + 0.2 × (-$2,000) = +$2,000`

---

## 4. Daily Schedule and Typical Day Walkthrough

### Market Zones

| Zone | Hours (PST) | Discord Polling | Position Updates |
|------|-------------|----------------|-----------------|
| **Hot** | 6:25 - 7:45 AM | Every 3 seconds | Every 5 minutes |
| **Cruise** | 7:45 AM - 12:40 PM | Every 10 seconds | Every 15 minutes |
| **Off** | All other times + weekends | Every 60 seconds | Every 30 minutes |

### Winning Day Walkthrough

```
5:50 AM   Daemon starts (npm run daemon:start).
          PM2 launches the process. System checks Alpaca account,
          reconciles state, begins Discord polling.
          Webhook: "Discord Trader (Guru-Follow Mode) online."

6:04 AM   Guru posts: "Todays gameplan $SPY... The calls im watching
          3/4 $SPY Call at $688, 3/4 $IWM Call at $265"
          --> Classified: GAMEPLAN
          --> Webhook: "GAMEPLAN: Guru watching $SPY, $IWM (calls) today"
          --> Action: Track tickers. No trade yet.

6:25 AM   HOT ZONE BEGINS. Discord polling increases to every 3 seconds.

6:30 AM   Guru posts: "3/4 $IWM Call at $265 at 0.18"
          --> Classified: ENTRY (has ticker + strike + price)
          --> Action: BUY ~111 contracts of IWM $265 Call
             (flat $2,000 / $0.18 / 100 = 111 contracts)
          --> Limit order submitted at $0.27 (1.5x signal price)
          --> System polls Alpaca every 500ms for up to 10s waiting for fill
          --> Webhook: "FILLED: 111x IWM $265 CALL @ $0.21 ($2,331)"

6:35 AM   Position crosses +50% milestone.
          --> Webhook: "MILESTONE +50%: IWM $265 Call. Entry $0.21, Now $0.32.
              Holding for guru exit signal."

6:37 AM   Guru posts: "You can get a better fill down here... at 0.09"
          --> Classified: SCALE_IN ("better fill" pattern + price)
          --> Webhook: "SCALE IN signal (not executing). Holding current position."
          --> Action: HOLD. No sell. No additional buy.

6:40 AM   5-minute position update.
          --> Webhook: "POSITION UPDATE: IWM $265 Call
              Entry: $0.21 | Now: $0.25 | P&L: +$444 (+19.0%)
              Qty: 111 contracts | Half sold: No
              Time in trade: 10 min"

7:26 AM   Guru posts: "What a comeback. You can sell half here to be safe"
          --> Classified: PARTIAL_EXIT ("sell half" + "to be safe")
          --> Action: SELL 55 contracts (half of 111)
          --> Webhook: "SOLD HALF: 55x IWM $265 CALL. Keeping 56 runners."

7:45 AM   CRUISE ZONE. Polling slows to every 10 seconds.

          ...guru may post "sell all" or go quiet...

12:40 PM  FORCE CLOSE. System sells all remaining contracts.
          --> Webhook: "SAFETY CLOSE (eod-force-close): Sold 56x IWM $265 CALL"

1:00 PM   EOD RESET. State file cleared. Ready for tomorrow.
```

### Losing Day

The flow is identical except:

- The position goes red instead of green
- Milestone alerts fire at -25%, -50%, -75% (informational only, no sell)
- The guru may go quiet (no "sell half" signal comes)
- The position stays open until 12:40 PM force close
- You lose the premium paid (up to $2,000)
- If the daemon crashes, PM2 auto-restarts it; reconciliation recovers the position

---

## 5. Component Deep Dive

### 5.1 Discord Monitor (`src/discord/monitor.ts`)

The Discord monitor is the entry point for all signals. It polls the Discord REST API for new messages in the guru's channel.

**How it works:**

1. On startup, calls `seedLastMessageId()` to fetch the most recent message ID (so it doesn't re-process old messages).
2. Calls `schedulePoll()` which sets a timer based on the current market zone (3s / 10s / 60s).
3. Each `poll()` call fetches up to 10 messages newer than `lastMessageId`.
4. New messages are filtered by the guru's username (`DISCORD_AUTHOR_NAME`, case-insensitive).
5. Each guru message is passed to `processMessage()`.

**Message processing (`processMessage()`):**

1. Extracts text content from the message body and any embeds.
2. Collects image URLs from attachments (sent to the LLM for visual understanding).
3. Calls `MessageClassifier.classify()` with the text, images, and the last 10 messages as context.
4. Appends to `recentMessages` window (max 10, used for LLM context).
5. If the classification is not `IRRELEVANT`, forwards to `tradeManager.handleMessage()`.

**Health monitoring:**

- If Discord polling fails **5 consecutive times**, sends a health alert via webhook.
- During the hot zone, if **no guru messages for 30 minutes**, sends a silence alert (guru might be absent).
- On HTTP 429 (rate limit), reads `retry_after` from the response, waits, and retries.

### 5.2 Message Classifier (`src/parser/message-classifier.ts` + `src/parser/llm-classifier.ts`)

The classifier determines what type of message the guru posted. It uses a two-tier approach with three levels of fallback.

**Classification pipeline:**

```
Guru Message
    │
    ▼
┌─────────────────────────┐
│ 1. Claude (Anthropic)   │  Primary -- understands context, reads images,
│    claude-sonnet-4-20250514   │  handles ambiguous phrasing
│    Timeout: 5 seconds   │
└────────┬────────────────┘
         │ confidence >= 0.7? ──Yes──> Use result
         │ No / Error
         ▼
┌─────────────────────────┐
│ 2. Grok (xAI)           │  Fallback -- fast, decent at classification
│    grok-3-mini-fast     │  (grok-4-1-fast-non-reasoning for images)
│    Timeout: 5 seconds   │
└────────┬────────────────┘
         │ confidence >= 0.7? ──Yes──> Use result
         │ No / Error
         ▼
┌─────────────────────────┐
│ 3. Regex Patterns        │  Last resort -- pattern matching
│    (no API calls)        │
└─────────────────────────┘
```

**LLM classification details:**

- The LLM receives the guru's text, any image attachments (vision-capable models), and a system prompt that defines all six message types with examples.
- It returns a JSON object with `type`, `confidence` (0-1), `reasoning`, and optionally extracted `signal` data (ticker, strike, price, direction).
- A 5-second timeout via `AbortController` prevents the LLM from blocking the pipeline.

**Regex fallback priority order:**

1. `FULL_EXIT` patterns: "sell all", "close all", "done for the day"
2. `PARTIAL_EXIT` patterns: "sell half", "take profits", "to be safe"
3. `GAMEPLAN` patterns: "game plan", "calls im watching"
4. `SCALE_IN` patterns: "adding here", "better fill"
5. `UPDATE` keywords: "pump", "cooking", "amazing", gain percentages
6. If a parseable trade signal (ticker + strike + price) is found: `ENTRY`

Exit signals are checked first so that a message like "sell all $SPY calls" is classified as FULL_EXIT, not ENTRY.

**Audit logging:**

Every classification is appended to `logs/classifications.jsonl` as a single JSON line with the message text, classification result, LLM provider used, confidence score, and timestamp. This enables post-hoc analysis of classification accuracy.

### 5.3 Signal Parser (`src/parser/signal-parser.ts`)

When a message is classified as ENTRY (or the classifier extracts signal data), the signal parser extracts the structured trade details: ticker, direction (call/put), strike price, and entry price.

**Supported message formats:**

```
$IWM Put at $265 at 0.12          Format 1: $TICKER Direction at $STRIKE at PRICE
$SPY Call 580 @ 1.25              Format 2: $TICKER Direction STRIKE @ PRICE
$TSLA 250P at 0.45               Format 3: $TICKER STRIKEC/P at PRICE
Buy $QQQ 490C for 0.80           Format 4: Buy/Sell $TICKER STRIKEC/P PRICE
```

The parser tries each pattern in order and returns the first match. It also extracts optional fields like expiration date, stop loss, and target price if present in the message.

**Output (`TradeSignal`):**

```typescript
{
  raw: string;          // original message text
  ticker: string;       // e.g. "IWM"
  direction: string;    // "call" or "put"
  strikePrice: number;  // e.g. 265
  entryPrice: number;   // e.g. 0.18
  expiration?: string;  // e.g. "2/11"
  stopLoss?: number;
  target?: number;
  timestamp: string;
  messageId: string;
}
```

### 5.4 Guru Trade Manager (`src/trading/guru-trade-manager.ts`)

This is the core of the system. It manages the entire trade lifecycle from entry to exit, including state persistence, order verification, and reconciliation with Alpaca.

**Key constants:**

| Constant | Value | Purpose |
|----------|-------|---------|
| `BUDGET_FLAT` | $2,000 | Fixed budget per trade |
| `FORCE_CLOSE_HOUR/MINUTE` | 12:40 PM | EOD close time |
| `MAX_ENTRY_MULTIPLIER` | 1.5x | Max limit price vs signal price |
| `FILL_POLL_INTERVAL_MS` | 500ms | How often to check if order filled |
| `FILL_TIMEOUT_MS` | 10,000ms | Max time to wait for fill |
| `SELL_RETRY_ATTEMPTS` | 3 | Retry count for failed sells |
| `SELL_RETRY_DELAY_MS` | 2,000ms | Delay between sell retries |
| `MARKET_OPEN` | 6:30 AM | Options market open (PST) |
| `PENDING_ENTRY_DEADLINE` | 7:00 AM | Cancel queued entries after this |

**Message handling flow:**

1. Deduplication: each `messageId` is processed only once.
2. Dispatch by classification type to the appropriate handler.

**Entry flow:**

1. Guard checks: no duplicate position, haven't already bought today, haven't already closed this ticker today, no existing open positions.
2. Build the OCC options symbol (e.g., `IWM260304C00265000`).
3. Set `pendingEntry` in state (so if the process crashes, it can retry).
4. Cancel any existing open orders.
5. Compute quantity: `$2,000 / (limitPrice × 100)`, clamped between 1 and 500 contracts.
6. Submit a limit buy order at `signal.entryPrice × 1.5`.
7. Poll Alpaca every 500ms for up to 10 seconds waiting for fill confirmation.
8. On fill: record actual `filled_avg_price` as `entryPrice`, create position in state, set `boughtToday` flag, clear `pendingEntry`.
9. On market-hours error (pre-market): keep `pendingEntry` for automatic retry at 6:30 AM.
10. On timeout: cancel the order, notify the user.

**Exit flow (partial):**

1. Sell half the position (qty / 2, rounded down).
2. Set `halfSold = true` on the position.
3. If `halfSold` is already true, treat as full exit instead.

**Exit flow (full):**

1. Sell all remaining contracts.
2. Move position to `closedToday` array.
3. Remove from active `positions`.

**Sell verification (`sellWithVerification()`):**

1. Submit a market sell order.
2. Poll for fill confirmation (up to 10s).
3. If the sell fails, retry up to 3 times with 2-second delays.
4. If all retries fail, store in `pendingSell` for the safety check loop to retry every 10 seconds.
5. After a successful sell, run `postSellReconciliation()` 5 seconds later to verify no contracts remain (handles partial fills or race conditions).

**Reconciliation (every 60 seconds):**

1. Fetch all positions from Alpaca via `getPositions()`.
2. Compare with local state:
   - **Orphaned Alpaca position** (on Alpaca but not in state): re-add to state and track it.
   - **Stale state position** (in state but not on Alpaca): only remove after **3 consecutive checks** confirm it's gone.
   - **Quantity mismatch**: sync from Alpaca's actual quantity.

**Force close (12:40 PM PST):**

1. Triggered by the safety check loop every 10 seconds.
2. Sells all positions in chunks (max 50 contracts per order).
3. Falls back to Alpaca's `closePosition()` endpoint if individual sells fail.
4. Runs a post-EOD check 5 seconds later for any orphaned contracts.
5. Hard deadline: 12:55 PM -- any remaining positions trigger emergency close.

### 5.5 Alpaca Client (`src/alpaca/client.ts`)

A typed REST client for the Alpaca Trading API.

**Methods:**

| Method | Purpose |
|--------|---------|
| `getAccount()` | Fetch account balance, buying power, equity |
| `createOrder(request)` | Submit a buy or sell order |
| `getOrders(status?)` | List orders (open, closed, all) |
| `getOrder(id)` | Get a specific order's status and fill details |
| `cancelOrder(id)` | Cancel a specific order |
| `cancelAllOrders()` | Cancel all open orders |
| `getPositions()` | List all open positions |
| `getPosition(symbol)` | Get a specific position |
| `closePosition(symbol)` | Close a position via Alpaca's endpoint |

**Error handling (`AlpacaError`):**

Every failed API call throws an `AlpacaError` with:
- `status`: HTTP status code
- `body`: response body text
- `isNotFound`: true if 404 (position genuinely doesn't exist)
- `isTransient`: true if 5xx or 429 (temporary failure -- safe to retry)

This distinction is critical. A 404 means the position is gone. A 500 or 429 means Alpaca had a hiccup -- the position likely still exists. The system never treats transient errors as "position closed."

**Order types used:**

- **Buy entries**: Limit orders with `limit_price` set to 1.5x the guru's signal price, `time_in_force: 'day'`
- **Sell exits**: Market orders, `time_in_force: 'day'`

### 5.6 Notifier (`src/notifications/notifier.ts`)

Sends notifications through two channels:

1. **Discord Webhook** (primary): Rich embeds with color coding, descriptions up to 4096 characters, footer, and timestamp.
2. **stdout `[NOTIFY]`** (fallback): Plain text logged to stdout for OpenClaw to pick up.

**Notification types and colors:**

| Type | Color | When |
|------|-------|------|
| `SIGNAL_RECEIVED` | Blue | Guru message classified |
| `TRADE_OPENED` | Green | Options bought |
| `TRADE_UPDATE` | Blue | Position update or milestone |
| `TRADE_CLOSED` | Orange | Position sold (guru signal or EOD) |
| `EOD_SUMMARY` | Purple | End of day recap |
| `EOD_CLOSE` | Orange | 12:40 PM force close |
| `SAFETY_STOP` | Red | Safety mechanism triggered |
| `ERROR` | Red | System error |

**Webhook reliability:**

- Up to 3 retries with exponential backoff on failure.
- On HTTP 429 (rate limit): honors `retry_after` header, waits, then retries.
- Fire-and-forget: webhook failures never block trade execution.

### 5.7 Streamer (`streamer/index.js`)

An optional backup process that connects to the Alpaca OPRA WebSocket for real-time options price data.

**Purpose:** Provides a secondary 12:40 PM EOD close mechanism with sub-second precision, independent of the main daemon.

**How it works:**

1. Connects to `wss://stream.data.alpaca.markets/v1beta1/options` using live Alpaca credentials.
2. Reads `state/trading-state.json` to know which options symbols to subscribe to.
3. Watches the state file for changes (new positions added).
4. At 12:40 PM PST, uses the Alpaca API to close any open positions.

**Configuration:** Reads credentials from `../.alpaca-live-keys` (separate from the main `.env`).

**Important:** The streamer runs as a separate Node.js process, not managed by PM2. It's started manually via `cd streamer && npm start`.

---

## 6. Safety Mechanisms

These mechanisms were added after a catastrophic $19,807 paper loss on March 4, 2026. Each one addresses a specific failure mode.

### 6.1 Typed API Errors

**Problem:** A transient Alpaca API error (500/429) was treated the same as a 404, causing the system to think a position was closed when it wasn't.

**Solution:** `AlpacaError` distinguishes between `isNotFound` (404, position genuinely gone) and `isTransient` (5xx/429, temporary failure). Transient errors are never treated as "position closed."

### 6.2 Triple-Confirm Position Removal

**Problem:** A single API hiccup made the system delete a position from state that still existed on Alpaca.

**Solution:** Before removing a position from state, the safety check requires **3 consecutive confirmed 404 responses** from Alpaca. One bad response cannot wipe state.

### 6.3 Alpaca Reconciliation (Every 60 Seconds)

**Problem:** State could drift from reality if orders filled externally, the process crashed mid-trade, or API errors caused missed updates.

**Solution:** Every 60 seconds (and on startup), the system calls `getPositions()` and compares with local state:

- **Orphaned Alpaca position** (on Alpaca but not in state): re-added and tracked.
- **Stale state position** (in state but not on Alpaca): removed only after 3 consecutive checks.
- **Quantity mismatch**: synced from Alpaca's actual quantity.

### 6.4 Order Fill Verification

**Problem:** The system recorded the guru's signal price as the entry price, not the actual fill price. P&L calculations were wrong.

**Solution:** After submitting an order, the system polls Alpaca's order status every 500ms for up to 10 seconds. It records the actual `filled_avg_price` as the entry price. If the order doesn't fill within 10s, it's cancelled and the user is notified.

### 6.5 PM2 Auto-Restart

**Problem:** The daemon died when OpenClaw (the AI assistant) was restarted, and the 12:40 PM EOD close never fired. Positions expired worthless.

**Solution:** The daemon runs under PM2 with `autorestart: true`, max 50 restarts, and a 5-second restart delay. If it crashes for any reason, PM2 restarts it. On startup, it reconciles with Alpaca and notifies if resuming with open positions.

### 6.6 Pre-Market Entry Queue

**Problem:** The guru sometimes signals entry before the options market opens at 6:30 AM PST. Orders submitted before market open get rejected.

**Solution:** If an entry order is rejected with a market-hours error, the system stores the signal in `state.pendingEntry` and retries every 10 seconds once the market opens. The pending entry is cancelled if it hasn't filled by 7:00 AM PST.

### 6.7 Sell Order Retry

**Problem:** A guru exit signal ("sell half") could fail due to a transient API error, and the system would never retry.

**Solution:** Failed sells are retried up to 3 times with 2-second delays. If all attempts fail, the sell is stored in `state.pendingSell` and retried every 10 seconds by the safety check loop until it succeeds.

### 6.8 Discord Health Alerting

**Problem:** Discord API could go down silently, and the system would miss guru signals without anyone knowing.

**Solution:** If Discord polling fails 5 consecutive times, a webhook alert is sent. During the hot zone, if no guru messages arrive for 30 minutes, a silence alert is sent (guru might be absent, or the API might be broken).

---

## 7. State Management

### 7.1 Trading State (`state/trading-state.json`)

This file tracks everything about the current trading day. It is reset at 1:00 PM PST.

```json
{
  "todaysGameplan": {
    "tickers": ["IWM", "SPY"],
    "direction": "call"
  },
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
      "guruMessages": [
        "entry signal @ $0.18, filled @ $0.21",
        "update: cooking",
        "sold half (200x)"
      ],
      "lastMilestone": 100
    }
  },
  "closedToday": [],
  "boughtToday": true,
  "dayTradesUsed": 0,
  "pendingEntry": null,
  "pendingSell": null
}
```

**Key fields:**

| Field | Purpose |
|-------|---------|
| `todaysGameplan` | Tickers and direction the guru is watching today |
| `positions` | Active positions keyed by OCC symbol |
| `positions[].signalPrice` | Price the guru mentioned in the signal |
| `positions[].entryPrice` | Actual Alpaca fill price (used for all P&L) |
| `positions[].halfSold` | Whether the "sell half" has been executed |
| `positions[].lastMilestone` | Highest milestone hit (avoids repeat alerts) |
| `closedToday` | Positions that were closed today (prevents re-entry) |
| `boughtToday` | Whether we've already bought today (one buy per day) |
| `pendingEntry` | Queued entry for pre-market signals |
| `pendingSell` | Failed sell awaiting retry |

### 7.2 System Health (`state/system-health.json`)

Written every 60 seconds by the heartbeat loop. Used by OpenClaw to check system status.

Contains: daemon uptime, current market zone, number of open positions, LLM classifier status, last poll time, consecutive poll errors.

### 7.3 Classification Audit Log (`logs/classifications.jsonl`)

One JSON line per classified message. Contains the message text, classification type, confidence score, LLM provider used, reasoning, and timestamp. Used for post-hoc analysis of classification accuracy.

### 7.4 Daily Notes (`memory/YYYY-MM-DD.md`)

Created by OpenClaw during daily review. Contains P&L summary, notable events, lessons learned, and any system issues from the day.

---

## 8. Configuration and Environment

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DISCORD_USER_TOKEN` | Yes | -- | Discord user token for REST API polling |
| `DISCORD_CHANNEL_ID` | Yes | -- | Discord channel ID to monitor |
| `DISCORD_AUTHOR_NAME` | No | `Stocksandrealestate` | Filter messages by this author name |
| `DISCORD_POLL_INTERVAL_MS` | No | `3000` | Base poll interval in ms (overridden by adaptive logic) |
| `ALPACA_API_KEY` | Yes | -- | Alpaca API key (paper or live) |
| `ALPACA_API_SECRET` | Yes | -- | Alpaca API secret |
| `ALPACA_BASE_URL` | No | `https://paper-api.alpaca.markets` | Alpaca trading endpoint |
| `ALPACA_DATA_URL` | No | `https://data.alpaca.markets` | Alpaca market data endpoint |
| `BUDGET_PERCENT` | No | `25` | Legacy -- system uses flat $2,000 now |
| `MAX_CONCURRENT_POSITIONS` | No | `3` | Max simultaneous positions |
| `DISCORD_WEBHOOK_URL` | No | `""` | Discord webhook for trade notifications |
| `ANTHROPIC_API_KEY` | No | `""` | Anthropic API key for Claude classifier |
| `GROK_API_KEY` | No | `""` | xAI API key for Grok fallback classifier |
| `LLM_CLASSIFIER_ENABLED` | No | `true` | Enable LLM classification |
| `LLM_CLASSIFIER_TIMEOUT_MS` | No | `5000` | Max wait time for LLM response |
| `LOG_LEVEL` | No | `info` | Winston log level |

### PM2 Configuration (`ecosystem.config.js`)

| Setting | Value | Purpose |
|---------|-------|---------|
| `script` | `tsx src/index.ts` | TypeScript execution without build step |
| `autorestart` | `true` | Restart on crash |
| `max_restarts` | `50` | Max restart attempts |
| `restart_delay` | `5000` | 5 seconds between restarts |
| `max_memory_restart` | `500M` | Restart if memory exceeds 500MB |
| `error_file` | `logs/pm2-error.log` | Stderr output |
| `out_file` | `logs/pm2-out.log` | Stdout output |

### File Structure

```
discord-trader/
├── STRATEGY.md                     # Trading philosophy and rules
├── SYSTEM.md                       # System architecture documentation
├── DOCS.md                         # This file
├── ecosystem.config.js             # PM2 process manager config
├── package.json                    # Dependencies and scripts
├── tsconfig.json                   # TypeScript config (ES2022, CommonJS)
├── .env                            # Environment variables (not in git)
├── .env.example                    # Template for .env
│
├── src/
│   ├── index.ts                    # Main entry point (daemon + CLI)
│   ├── config.ts                   # Environment-based configuration
│   ├── alpaca/
│   │   └── client.ts              # Alpaca REST client (typed errors)
│   ├── discord/
│   │   └── monitor.ts             # Adaptive Discord polling
│   ├── parser/
│   │   ├── llm-classifier.ts      # Claude/Grok LLM classification
│   │   ├── message-classifier.ts  # LLM + regex pipeline
│   │   ├── signal-parser.ts       # Ticker/strike/price extraction
│   │   └── types.ts               # TradeSignal type definition
│   ├── trading/
│   │   └── guru-trade-manager.ts  # Trade lifecycle and state management
│   ├── notifications/
│   │   └── notifier.ts            # Discord webhook + stdout notifications
│   ├── utils/
│   │   ├── find-channel.ts        # Discord channel lookup helper
│   │   └── logger.ts              # Winston logging setup
│   └── test/
│       ├── preflight.ts           # 8-check preflight test suite
│       ├── simulate-day.ts        # Full day simulation test
│       ├── test-discord-history.ts
│       └── test-llm-providers.ts  # LLM provider connectivity tests
│
├── streamer/
│   ├── index.js                   # WebSocket options streamer (backup EOD)
│   ├── package.json               # Streamer dependencies (ws, msgpack-lite)
│   ├── README.md                  # Streamer documentation
│   └── start.sh                   # Launch script
│
├── scripts/
│   └── clean-start.sh             # Kill zombies, cancel orders, start fresh
│
├── state/
│   ├── trading-state.json         # Live trading state (not in git)
│   ├── system-health.json         # Daemon health (not in git)
│   └── trading-state.example.json # State file template
│
├── logs/                           # All logs (not in git)
│   ├── pm2-out.log
│   ├── pm2-error.log
│   ├── trades.log
│   ├── error.log
│   └── classifications.jsonl      # Classification audit log
│
├── memory/                         # Daily notes by OpenClaw (not in git)
│   └── YYYY-MM-DD.md
│
└── openclaw/                       # OpenClaw AI assistant config
    ├── AGENTS.md                   # Operating instructions
    ├── DAILY-START.md              # Copy-paste daily startup prompt
    ├── MEMORY.md                   # Long-term system facts
    ├── README.md                   # OpenClaw setup instructions
    └── SOUL.md                     # Persona and tone
```

---

## 9. How to Run

### Prerequisites

- Node.js (v18+)
- npm
- PM2 (`npm install -g pm2`)
- An Alpaca trading account with options enabled (Level 3)
- A Discord account with access to the guru's server
- An Anthropic API key (recommended) for Claude classifier
- A Discord webhook URL for notifications

### Initial Setup

```bash
git clone <repo-url> discord-trader
cd discord-trader
npm install
cp .env.example .env
# Edit .env with your actual credentials
```

### Daemon Mode (Primary)

```bash
npm run daemon:start        # Start with PM2 (auto-restarts on crash)
npm run daemon:stop         # Stop the daemon
npm run daemon:restart      # Restart the daemon
npm run daemon:logs         # View logs (last 100 lines)
npm run daemon:status       # Check PM2 process status
```

### Clean Start (Recommended for Daily Startup)

```bash
npm run daemon:clean-start  # Kill zombies, cancel open orders, start fresh
```

What `clean-start.sh` does:

1. Stops and deletes any PM2-managed discord-trader process
2. Kills any orphaned node processes running the code
3. Force-kills anything still remaining
4. Cancels all open Alpaca orders (safety measure)
5. Starts fresh with PM2
6. Saves PM2 process list

### CLI Commands

```bash
npx tsx src/index.ts portfolio    # Show account balance and positions
npx tsx src/index.ts state        # Show current trading state JSON
npx tsx src/index.ts close-all    # Force close all open positions
npx tsx src/index.ts reset        # Reset state for a new day
```

### Development Mode

```bash
npm run dev                 # Start with tsx watch (auto-reload, no PM2)
```

### Streamer (Optional Backup)

```bash
cd streamer
npm install
npm start                   # Connects to Alpaca OPRA WebSocket
```

### Testing

```bash
npm run test:preflight      # Run 8-check preflight suite
npm run test:simulate       # Run full day simulation
```

The preflight suite checks: Alpaca connectivity, account status, Discord polling, LLM classifier, webhook delivery, state file access, options market hours, and process health.

---

## 10. OpenClaw Integration

**OpenClaw** is a local AI assistant (similar to a coding agent) that serves as the human operator's interface to the system. It can start/stop the daemon, check health, review trades, and send WhatsApp-style notifications.

### Configuration Files (`openclaw/`)

| File | Purpose |
|------|---------|
| `SOUL.md` | Defines OpenClaw's persona: direct, numbers-first, PST timezone, no fluff. Reports P&L in dollars and percentages. Does not give financial advice or modify exit rules. |
| `AGENTS.md` | Operating instructions: session startup checklist, available commands, monitoring cadence, classification audit usage, daily note format. |
| `MEMORY.md` | Long-term facts: account details, guru schedule, exit rules, daemon commands, LLM classifier details, safety mechanisms, lessons learned. Persists across sessions. |
| `DAILY-START.md` | Copy-paste prompt for daily startup. Steps: run preflight, clean-start daemon, verify health, check for positions. Also includes mid-day recovery and end-of-day review prompts. |

### How OpenClaw Fits In

```
You (the user)
    │
    ▼
OpenClaw (AI assistant)
    │
    ├── Reads state/system-health.json to check daemon health
    ├── Reads state/trading-state.json to see positions
    ├── Runs CLI commands (portfolio, state, close-all)
    ├── Reads logs/classifications.jsonl for audit
    ├── Writes memory/YYYY-MM-DD.md daily notes
    └── Starts/stops daemon via npm scripts
    │
    ▼
Discord Trader Daemon (runs independently)
    │
    └── Sends [NOTIFY] to stdout (OpenClaw reads PM2 logs)
    └── Sends Discord webhook notifications (you get these directly)
```

OpenClaw is optional. The daemon runs completely independently. OpenClaw adds a human-friendly monitoring and control layer on top.

---

## 11. Lessons Learned

### Feb 17, 2026 -- First Live Day (-$5,743)

- Trailing stops were too aggressive -- position was up +82% then gave it all back
- "Adding more" was interpreted as a danger signal, causing premature exits
- 30-minute timeout sold everything before the play had time to work

### Feb 18 - Mar 3, 2026 -- 3 Consecutive Losses

- Autonomous exit logic (trailing stops, time-based sells) exited before the guru called it
- Positions sold at -30% later recovered to +200%
- The guru's plays need time and room to breathe

### Mar 4, 2026 -- System Overhaul

- Removed ALL autonomous exits except 12:40 PM EOD close
- Implemented guru-follow mode: only exit on guru's signal or 12:40 PM
- Added LLM message classifier to understand all guru message types
- Increased polling to 3s during hot zone
- Removed -60% hard stop and daily loss halt
- Added periodic position updates and milestone alerts

### Mar 4, 2026 -- Paper Trade Day (-$19,807)

The worst day, but the most instructive:

- **Root cause:** A transient Alpaca API error made `getAlpacaPosition()` return null. The safety check interpreted this as "position closed externally" and deleted it from state. When the guru called "sell half" at a +120% gain, the system said "no open position" and did nothing. The position then crashed to near zero.
- **Contributing factors:**
  1. No notification delivery -- `[NOTIFY]` stdout wasn't reaching the user
  2. Daemon died when OpenClaw was restarted, so 12:40 PM EOD close never fired
  3. Entry price stored was the guru's signal price, not actual fill price
- **Fixes applied:** Typed API errors, triple-confirm position removal, 60-second reconciliation, order fill verification, Discord webhook notifications, PM2 auto-restart

### Key Takeaways

1. Never override the guru -- his silence doesn't mean the trade is dead
2. "Adding" signals are bullish, not bearish
3. Entry price matters less than staying in the trade
4. Early peaks are noise -- don't trail stop on +50%, the real move might be +200%
5. The guru always posts when it's time to take profit -- wait for his call
6. Paper trading overstates returns by ~20-40% due to slippage
7. Accept losing days -- max $2,000 loss on a bad day, gains on good days far outweigh
8. Transient API errors must never be treated as definitive state changes
9. Notifications must work independently of the AI assistant (Discord webhooks)
10. The daemon must survive assistant restarts (PM2)
