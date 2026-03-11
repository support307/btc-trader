# AGENTS.md -- Trading Systems Operating Instructions

This file covers two independent systems. Check MEMORY.md for account details and system facts.

## Session Start

Before responding to any trading-related message:
1. Read `MEMORY.md` for system context and rules
2. Check guru system health: `cat ~/projects/discord-trader/state/system-health.json`
3. Check BTC trader health: `cat ~/projects/discord-trader/state/btc-health.json`
4. Read today's daily note (`memory/YYYY-MM-DD.md`) if it exists
5. Read yesterday's daily note for recent context

## Daily Startup (Copy-Paste Prompt)

See `~/projects/discord-trader/openclaw/DAILY-START.md` for startup messages for both systems.

---

## SYSTEM 1: Discord Guru-Follow Operations

## Core Responsibilities

### When asked about trading status / "how's our portfolio"

Run these commands in `~/projects/discord-trader`:

```bash
npx tsx src/index.ts portfolio    # Account equity + open positions
npx tsx src/index.ts state        # Current trading state (gameplan, positions, closed trades)
```

Report: equity, cash, open positions with P&L in dollars and percentage, time in trade.

### Quick health check (no CLI needed)

Read the health file directly -- it's updated every 60 seconds:

```bash
cat ~/projects/discord-trader/state/system-health.json
```

This tells you: daemon uptime, current zone, position count, LLM status, classification stats, and last classification details. If `lastHeartbeat` is more than 3 minutes old, the daemon may be down.

### When asked to start/run the trading system

**ALWAYS use clean-start to kill zombie processes first:**

```bash
cd ~/projects/discord-trader && npm run daemon:clean-start
```

This script:
1. Stops and deletes any existing PM2 discord-trader processes
2. Kills any orphaned node/tsx processes running the daemon or streamer
3. Cancels all open Alpaca orders (safety measure)
4. Starts the daemon fresh with PM2

If for some reason `clean-start` fails, do it manually:

```bash
cd ~/projects/discord-trader
pm2 stop discord-trader 2>/dev/null; pm2 delete discord-trader 2>/dev/null
pkill -f "tsx.*src/index.ts" 2>/dev/null
pkill -f "streamer/index.js" 2>/dev/null
sleep 1
pm2 start ecosystem.config.js
```

Confirm it started by checking `npm run daemon:status`. Report back that the daemon is running and monitoring Discord.

### When asked to stop the system

```bash
cd ~/projects/discord-trader && npm run daemon:stop
```

### When the daemon appears crashed or notifications stop

1. Check health file first: `cat ~/projects/discord-trader/state/system-health.json`
2. Check status: `cd ~/projects/discord-trader && npm run daemon:status`
3. Check logs: `npm run daemon:logs`
4. Restart if needed: `npm run daemon:restart`
5. Report what happened and current position status

### When asked to manually close positions

```bash
cd ~/projects/discord-trader && npx tsx src/index.ts close-all
```

Only do this when explicitly asked or at end of day.

### When asked to run preflight checks / verify the system

**ALWAYS run preflight before starting the daemon for the day:**

```bash
cd ~/projects/discord-trader && npm run test:preflight
```

This runs 8 checks in ~15 seconds: env vars, Alpaca API, Discord read, Discord webhook, Anthropic LLM, Grok LLM, classifier pipeline, and trading state. All must PASS before trading. If any FAIL, diagnose and fix before starting the daemon.

### When asked to run a full test/simulation

```bash
cd ~/projects/discord-trader && npm run test:simulate
```

This runs 4 phases: webhook test, classifier test, full day simulation, bug fix verification.

## Classification Audit Log

Every message classified by the system is logged to `~/projects/discord-trader/logs/classifications.jsonl`. Each line is a JSON object:

```json
{"ts":"2026-03-04T14:25:00Z","messageId":"123","raw":"adding here @everyone","type":"SCALE_IN","confidence":0.92,"reasoning":"Guru adding to position","classifiedBy":"llm","imageCount":0}
```

### Reviewing the audit log

```bash
# See all today's classifications
cat ~/projects/discord-trader/logs/classifications.jsonl | grep "$(date +%Y-%m-%d)"

# Find low-confidence LLM classifications (potential misclassifications)
cat ~/projects/discord-trader/logs/classifications.jsonl | grep '"classifiedBy":"llm"' | grep -v '"confidence":0.9'

# Find regex fallbacks (LLM was unavailable or too slow)
cat ~/projects/discord-trader/logs/classifications.jsonl | grep '"classifiedBy":"regex"'

# Count classifications by type
cat ~/projects/discord-trader/logs/classifications.jsonl | grep "$(date +%Y-%m-%d)" | grep -o '"type":"[^"]*"' | sort | uniq -c
```

### What to watch for

- **Low-confidence classifications** (< 0.8): these might be wrong. Check the raw message and reasoning.
- **Regex fallbacks**: if all classifications are regex, the LLM may be down (check `ANTHROPIC_API_KEY` is set, or API outage).
- **Missed EXIT signals**: if the guru said to sell but the log shows UPDATE or IRRELEVANT, flag it immediately and manually close the position.

## Periodic Monitoring Cadence

During market hours (6:00 AM - 1:00 PM PST):
- **Every 15 minutes**: Check `system-health.json` -- is the daemon alive? Is `llmEnabled` true?
- **After any trade action**: Review the classification log entry for that signal. Was it LLM or regex? What was the confidence?

At end of day (after 1:00 PM PST):
- **Review full classification log**: look at all guru messages. Were they classified correctly?
- **Write the daily note** (see below)

## Trading Rules (NEVER VIOLATE)

- **ONE BUY per day, ONE SELL per day.** The system enforces this with a `boughtToday` flag. Never try to buy a second time.
- **NEVER** add stop losses, trailing stops, hard stops, or any autonomous exit logic
- **NEVER** sell a position unless the guru signals it or it is 12:40 PM PST
- **NEVER** override the guru's timing -- if the position is red, we hold
- **NEVER** scale in or add to a position. Guru scale-in signals are logged but not executed.
- The system only buys options (defined risk). Maximum loss = premium paid ($2,000). You CANNOT owe money.
- Accept losing days. A $2,000 loss on a bad day is acceptable when good days return significant gains.
- Budget is flat $2,000 per trade. Never risk more than $2,000 on a single trade.

## Daily Notes

At end of each trading day (after 1:00 PM PST), write a daily note to `memory/YYYY-MM-DD.md` with:

```markdown
# Trading Day YYYY-MM-DD

## Result
- [WIN/LOSS]: [ticker] [strike] [type] -- entry $X.XX, exit $X.XX, P&L $X,XXX (+XX%)

## Guru Signals
- [timestamp]: [classification] -- [message summary]

## Classification Review
- Total messages classified: X (LLM: Y, regex: Z)
- Low-confidence flags: [list any < 0.8]
- Misclassifications: [list any]

## System Notes
- [Any issues, daemon restarts, notification problems, etc.]
```

## Reference Documentation

For detailed system architecture, message classification patterns, polling zones, and the full typical day walkthrough, read:
- `~/projects/discord-trader/SYSTEM.md` (system architecture and operations)
- `~/projects/discord-trader/STRATEGY.md` (trading philosophy and rules)

---

## SYSTEM 2: BTC 5-Minute Trader Operations

The BTC trader is fully autonomous. Once started, it finds Polymarket markets, analyzes data, and places trades every 5 minutes without any human input. Your job is to start it, monitor it, restart it if it crashes, and remind the user to claim winnings.

### Prerequisites (VERIFY BEFORE STARTING)

1. **VPN**: NordVPN must be connected to **Brazil**. Verify with:

```bash
curl -s https://polymarket.com/api/geoblock | cat
```

Expected: `{"blocked":false,"country":"BR"}`. If `blocked` is `true`, the VPN is off or set to a blocked region. Do NOT start the bot until this returns `false`.

2. **Environment**: Verify `.env` has `POLYMARKET_PRIVATE_KEY` set and `BTC_DRY_RUN=false`.

### Starting the BTC Trader

```bash
cd ~/projects/discord-trader && npm run btc:start
```

The bot will:
1. Kill any previous instance via PID file (`state/btc-trader.pid`)
2. Check geo-block status
3. Connect to Binance WebSocket for BTC price
4. Begin processing 5-minute windows

The process runs in the foreground. To run in background:

```bash
cd ~/projects/discord-trader && nohup npm run btc:start > logs/btc-trader.log 2>&1 &
```

After starting, verify first output appears within 30 seconds. You should see:
- "BTC 5-Minute Trading Daemon starting..."
- "Binance BTC/USDT WebSocket connected"
- "BTC price: $XXXXX.XX"
- A startup notification sent to Discord

### Stopping the BTC Trader

Option 1 -- Use the PID file:

```bash
kill $(cat ~/projects/discord-trader/state/btc-trader.pid)
```

Option 2 -- Kill by name:

```bash
pkill -f "btc-trader/index.ts"
```

Option 3 -- Nuclear (kill everything):

```bash
pkill -9 -f "btc-trader/index.ts"
```

### Checking BTC Trader Status

Quick check -- is the process running?

```bash
ps aux | grep "btc-trader" | grep -v grep
```

Check the state file:

```bash
cat ~/projects/discord-trader/state/btc-trading-state.json
```

Check the health file:

```bash
cat ~/projects/discord-trader/state/btc-health.json
```

If `lastTick` in the health file is more than 10 minutes old, the daemon is likely dead.

### Checking Polymarket Balance

```bash
cd ~/projects/discord-trader && npm run btc:status
```

Or use the Polymarket CLI directly:

```bash
polymarket balance
```

### When the BTC Trader Crashes or Stops Sending Notifications

1. Check if the process is alive:

```bash
ps aux | grep "btc-trader" | grep -v grep
```

2. Check the PID file:

```bash
cat ~/projects/discord-trader/state/btc-trader.pid
```

3. If no process is running, restart:

```bash
cd ~/projects/discord-trader && npm run btc:start
```

The PID file auto-kills previous instances, so restarting is always safe.

4. Check the last log output for errors. If running via nohup:

```bash
tail -50 ~/projects/discord-trader/logs/btc-trader.log
```

5. Report what happened and current balance to the user.

### When Balance Is Low

The bot sends a Discord notification when balance is too low to place a trade (~$2.50 minimum needed). When you see this:

1. Tell the user: "Balance is low. Go to https://polymarket.com/portfolio and click Claim to redeem your winning positions."
2. The bot will automatically resume trading once balance is sufficient.

### CRITICAL: You Cannot Claim Winnings

The Polymarket CLI does not support redemption with Magic.Link proxy wallets. When the bot or you detect redeemable positions, you MUST tell the user to:

1. Go to https://polymarket.com/portfolio
2. Click the "Claim" button on winning positions
3. This recycles capital back into the available balance

Do NOT attempt to run `polymarket ctf redeem` -- it will fail silently.

### BTC Trader Monitoring Cadence

The BTC trader runs 24/7 (not just market hours). Monitor accordingly:

- **Every 30 minutes**: Check if the process is still alive (health file or `ps aux`)
- **Every 2 hours**: Check balance. If below $3, remind user to claim winnings.
- **On any Discord notification about errors**: Investigate immediately, restart if needed.

### Running Backtests

To evaluate strategy performance:

```bash
cd ~/projects/discord-trader && npm run btc:backtest:1d   # Last 24 hours
cd ~/projects/discord-trader && npm run btc:backtest:7d   # Last 7 days
```

### BTC Trader Rules (NEVER VIOLATE)

- **NEVER** manually place trades on Polymarket. The bot handles all execution.
- **NEVER** modify strategy parameters while the bot is running. Stop first, change config, then restart.
- **NEVER** run multiple instances. The PID file prevents this, but do not circumvent it.
- **ALWAYS** verify VPN is connected to Brazil before starting.
- **ALWAYS** remind the user to claim winnings when balance is low or redeemable positions are detected.
