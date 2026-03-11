# Daily Startup Messages for OpenClaw

Copy-paste the relevant message into OpenClaw to get each trading system running. The guru system runs during market hours only. The BTC trader runs 24/7.

---

# Part 1: Discord Guru-Follow System

Copy-paste this message each market morning (before 6:15 AM PST).

---

## The Message

```
Good morning. Start the discord-trader system for today's trading session.

Please follow these steps in order:

1. Read your operating docs:
   - ~/projects/discord-trader/openclaw/MEMORY.md
   - ~/projects/discord-trader/openclaw/AGENTS.md

2. Run the preflight test suite to verify all systems are working:
   cd ~/projects/discord-trader && npm run test:preflight

   This checks: env vars, Alpaca API, Discord read, Discord webhook,
   Anthropic LLM, Grok LLM, classifier pipeline, and trading state.
   ALL checks must PASS. If any FAIL, diagnose and fix before proceeding.

3. Kill all zombie processes and start fresh:
   cd ~/projects/discord-trader && npm run daemon:clean-start

4. Verify the system is running:
   cd ~/projects/discord-trader && npm run daemon:status

5. Check the system health file (wait 60s after start for first heartbeat):
   cat ~/projects/discord-trader/state/system-health.json

6. Confirm the health file shows:
   - lastHeartbeat is recent (within last 2 minutes)
   - llmEnabled is true
   - zone is correct for current time
   - positionCount is 0

7. Quick-check classification logs from yesterday (if any):
   tail -20 ~/projects/discord-trader/logs/classifications.jsonl

Report back with:
- Preflight results (all 8 checks PASS/FAIL)
- Account equity and buying power
- Trading state (should be empty/clean)
- Daemon status (online/offline)
- Any issues found

Then monitor throughout the day. The system will:
- Auto-enter when the guru posts an ENTRY signal (~6:30 AM PST)
- Send Discord webhook notifications for all events
- Auto-close at 12:40 PM PST if guru hasn't called exit
- Auto-reset state at 1:00 PM PST

Rules: ONE buy per day, ONE sell per day. No stop losses. No scale-in buys. Hold until guru says sell or 12:40 PM EOD.
```

---

## What OpenClaw Will Do

After receiving this message, OpenClaw will:

1. Read MEMORY.md and AGENTS.md to load all system context
2. Run `npm run test:preflight` to verify all 8 system components
3. Run `npm run daemon:clean-start` which:
   - Stops/deletes any PM2 processes
   - Kills orphaned node/tsx processes
   - Cancels any stale Alpaca orders
   - Starts the daemon fresh
4. Verify daemon is running and health file is current
5. Monitor throughout the day per AGENTS.md cadence

## If Something Goes Wrong Mid-Day

Send OpenClaw:

```
The discord-trader daemon appears to be down. Please:
1. Check: cat ~/projects/discord-trader/state/system-health.json
2. Check: cd ~/projects/discord-trader && npm run daemon:status
3. Check logs: cd ~/projects/discord-trader && npm run daemon:logs
4. If down, restart: cd ~/projects/discord-trader && npm run daemon:clean-start
5. Check if we have any open positions and report their P&L
```

## End of Day Review

Send OpenClaw after 1:00 PM PST:

```
Trading day is over. Please:
1. Check today's results: cd ~/projects/discord-trader && npx tsx src/index.ts portfolio
2. Review all classifications from today:
   cat ~/projects/discord-trader/logs/classifications.jsonl | grep "$(date +%Y-%m-%d)"
3. Check for any regex fallbacks or low-confidence classifications
4. Write a daily note to ~/projects/discord-trader/memory/$(date +%Y-%m-%d).md
5. Confirm state was reset for tomorrow
```

---

# Part 2: BTC 5-Minute Trader

The BTC trader runs 24/7. Use this message to start it (or restart it after a crash/reboot).

## BTC Trader Startup Message

```
Start the BTC 5-minute trading bot on Polymarket.

Please follow these steps in order:

1. Read your operating docs:
   - ~/projects/discord-trader/openclaw/MEMORY.md
   - ~/projects/discord-trader/openclaw/AGENTS.md

2. Verify VPN is connected to Brazil:
   curl -s https://polymarket.com/api/geoblock | cat
   This MUST return {"blocked":false}. If blocked is true, STOP and tell me
   to connect NordVPN to Brazil.

3. Kill any existing btc-trader processes:
   pkill -f "btc-trader/index.ts" 2>/dev/null; sleep 2

4. Start the BTC trader:
   cd ~/projects/discord-trader && nohup npm run btc:start > logs/btc-trader.log 2>&1 &

5. Wait 30 seconds, then verify it started:
   tail -30 ~/projects/discord-trader/logs/btc-trader.log

6. Confirm you see:
   - "BTC 5-Minute Trading Daemon starting..."
   - "Binance BTC/USDT WebSocket connected"
   - "BTC price: $XXXXX.XX"
   - A startup notification mentioning balance and adapter

7. Check for any redeemable positions:
   cat ~/projects/discord-trader/state/btc-trading-state.json

Report back with:
- VPN status (blocked or not, country)
- Balance (available USDC.e)
- Daemon status (running or failed to start)
- First trade decision (if a window has been processed)
- Any redeemable positions (remind me to claim at polymarket.com/portfolio)

The bot will now trade autonomously every 5 minutes. Monitor it per AGENTS.md.
```

## What OpenClaw Will Do

After receiving this message, OpenClaw will:

1. Read MEMORY.md and AGENTS.md for full BTC trader context
2. Verify VPN / geo-block status
3. Kill any existing instances (PID file also handles this, but belt-and-suspenders)
4. Start the daemon in background with nohup
5. Verify first output and report balance
6. Monitor per the cadence in AGENTS.md

## BTC Trader Mid-Day Check

Send OpenClaw periodically (or if notifications stop):

```
Check on the BTC trader bot. Is it still running?
1. ps aux | grep "btc-trader" | grep -v grep
2. cat ~/projects/discord-trader/state/btc-health.json
3. tail -20 ~/projects/discord-trader/logs/btc-trader.log
4. If it's down, restart it per the BTC startup procedure in AGENTS.md
5. Check balance: polymarket balance
6. If balance is below $3, remind me to claim winnings at polymarket.com/portfolio
```

## BTC Trader Stop

```
Stop the BTC trader bot.
1. kill $(cat ~/projects/discord-trader/state/btc-trader.pid) 2>/dev/null
2. pkill -f "btc-trader/index.ts" 2>/dev/null
3. Confirm no btc-trader processes are running: ps aux | grep "btc-trader" | grep -v grep
4. Report final balance
```
