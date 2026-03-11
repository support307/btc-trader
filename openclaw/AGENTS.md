# AGENTS.md -- BTC 5-Minute Trader Operating Instructions

Check MEMORY.md for account details, strategy parameters, and lessons learned.

## Session Start

Before responding to any trading-related message:
1. Read `MEMORY.md` for system context and rules
2. Check BTC trader health: `cat ~/projects/btc-trader/state/btc-system-health.json`
3. Check trading state: `cat ~/projects/btc-trader/state/btc-trading-state.json`

## Daily Startup (Copy-Paste Prompt)

See `~/projects/btc-trader/openclaw/DAILY-START.md` for startup, mid-day check, and stop messages.

---

## Core Responsibilities

### Prerequisites (VERIFY BEFORE STARTING)

1. **VPN**: NordVPN must be connected to **Brazil**. Verify:

```bash
curl -s https://polymarket.com/api/geoblock | cat
```

Expected: `{"blocked":false}`. If `blocked` is `true`, do NOT start the bot.

2. **Environment**: `.env` has `POLYMARKET_PRIVATE_KEY` set and `BTC_DRY_RUN=false`.

### Starting the BTC Trader

```bash
cd ~/projects/btc-trader && npm run btc:start
```

The bot will:
1. Kill any previous instance via PID file (`state/btc-trader.pid`)
2. Check geo-block status
3. Connect to Binance WebSocket for BTC price
4. Begin processing 5-minute windows

To run in background:

```bash
cd ~/projects/btc-trader && nohup npm run btc:start > logs/btc-trader.log 2>&1 &
```

After starting, verify within 30 seconds:
- "BTC 5-Minute Trading Daemon starting..."
- "Binance BTC/USDT WebSocket connected"
- "BTC price: $XXXXX.XX"
- Startup notification sent to Discord

### Stopping the BTC Trader

```bash
kill $(cat ~/projects/btc-trader/state/btc-trader.pid) 2>/dev/null
pkill -f "btc-trader/index.ts" 2>/dev/null
```

### Checking Status

Process alive?

```bash
ps aux | grep "btc-trader" | grep -v grep
```

Trading state:

```bash
cat ~/projects/btc-trader/state/btc-trading-state.json
```

Health file:

```bash
cat ~/projects/btc-trader/state/btc-system-health.json
```

If `lastTick` in the health file is more than 10 minutes old, the daemon is likely dead. Restart it.

### Checking Balance

```bash
cd ~/projects/btc-trader && npm run btc:status
```

### When the Bot Crashes or Stops Sending Notifications

1. Check if the process is alive: `ps aux | grep "btc-trader" | grep -v grep`
2. Check PID file: `cat ~/projects/btc-trader/state/btc-trader.pid`
3. If no process is running, restart: `cd ~/projects/btc-trader && npm run btc:start`
4. Check logs: `tail -50 ~/projects/btc-trader/logs/btc-trader.log`
5. Report what happened and current balance to the user

The PID file auto-kills previous instances, so restarting is always safe.

### When Balance Is Low

The bot sends a Discord notification when balance is too low (~$2.50 minimum needed). Tell the user:

> "Balance is low. Go to https://polymarket.com/portfolio and click **Claim** to redeem your winning positions."

The bot resumes trading automatically once balance is sufficient.

### CRITICAL: You Cannot Claim Winnings

The Polymarket CLI does not support redemption with Magic.Link proxy wallets. When the bot or you detect redeemable positions, you MUST tell the user to:

1. Go to https://polymarket.com/portfolio
2. Click the "Claim" button on winning positions
3. This recycles capital back into the available balance

Do NOT attempt to run `polymarket ctf redeem` -- it will fail silently.

---

## Monitoring Cadence

The BTC trader runs 24/7. Monitor accordingly:

- **Every 30 minutes**: Check health file -- is the daemon alive?
- **Every 2 hours**: Check balance. If below $3, remind user to claim winnings.
- **On any Discord notification about errors**: Investigate immediately, restart if needed.

---

## Running Backtests

```bash
cd ~/projects/btc-trader && npm run btc:backtest:1d   # Last 24 hours
cd ~/projects/btc-trader && npm run btc:backtest:7d   # Last 7 days
```

---

## Rules (NEVER VIOLATE)

- **NEVER** manually place trades on Polymarket. The bot handles all execution.
- **NEVER** modify strategy parameters while the bot is running. Stop first, change config, then restart.
- **NEVER** run multiple instances. The PID file prevents this, but do not circumvent it.
- **ALWAYS** verify VPN is connected to Brazil before starting.
- **ALWAYS** remind the user to claim winnings when balance is low or redeemable positions are detected.
