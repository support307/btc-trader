# Daily Startup Messages for OpenClaw

The BTC trader runs 24/7. Use these messages to start it, check on it, or stop it.

---

## First-Time Setup (Fresh Clone)

Use this prompt when setting up the project on a new machine for the first time.

```
Set up the BTC 5-minute trading bot from a fresh clone.

Please follow these steps in order:

1. Read your operating docs:
   - ~/projects/btc-trader/openclaw/MEMORY.md
   - ~/projects/btc-trader/openclaw/AGENTS.md

2. Install Node.js dependencies:
   cd ~/projects/btc-trader && npm install
   Verify tsx is available: npx tsx --version

3. Install the Polymarket CLI globally:
   npm install -g @polymarket/cli
   Verify it's in PATH: which polymarket

4. Create required directories:
   mkdir -p ~/projects/btc-trader/logs
   mkdir -p ~/projects/btc-trader/state

5. Verify .env exists and has the required keys:
   cat ~/projects/btc-trader/.env
   It MUST contain:
   - POLYMARKET_PRIVATE_KEY (starts with 0x)
   - DISCORD_WEBHOOK_URL (for trade notifications)
   - GROK_API_KEY (for sentiment analysis)
   - BTC_DRY_RUN=false
   - BTC_EXECUTION_ADAPTER=polymarket
   If .env is missing, copy from .env.example and fill in the real keys:
   cp ~/projects/btc-trader/.env.example ~/projects/btc-trader/.env

6. Verify the Polymarket wallet is configured:
   polymarket wallet show
   Should show the wallet address. If not configured, run:
   polymarket wallet create
   and import the private key from .env.

7. Verify VPN is connected to Brazil:
   curl -s https://polymarket.com/api/geoblock | cat
   This MUST return {"blocked":false}. If blocked is true, STOP and tell me
   to connect NordVPN to Brazil.

8. Test-run the bot (check it starts without errors):
   cd ~/projects/btc-trader && npm run btc:start
   Watch the first 30 seconds of output. You should see:
   - "BTC 5-Minute Trading Daemon starting..."
   - "Binance BTC/USDT WebSocket connected"
   - "BTC price: $XXXXX.XX"
   - Adapter: polymarket (NOT dry-run)
   If it says dry-run, the Polymarket CLI is not installed or wallet is not configured.

9. If the test looks good, kill it and start in background:
   pkill -f "btc-trader/index.ts" 2>/dev/null; sleep 2
   cd ~/projects/btc-trader && nohup npm run btc:start > logs/btc-trader.log 2>&1 &

10. Wait 30 seconds, verify:
    tail -30 ~/projects/btc-trader/logs/btc-trader.log
    cat ~/projects/btc-trader/state/btc-trading-state.json

Report back with:
- Node.js version and npm install status
- Polymarket CLI version and wallet address
- VPN status (blocked or not)
- Balance (available USDC.e)
- Daemon status (running or failed)
- Adapter (polymarket or dry-run)
- Any issues encountered
```

---

## Startup Message

Copy-paste this to get the bot running (or to restart after a crash/reboot):

```
Start the BTC 5-minute trading bot on Polymarket.

Please follow these steps in order:

1. Read your operating docs:
   - ~/projects/btc-trader/openclaw/MEMORY.md
   - ~/projects/btc-trader/openclaw/AGENTS.md

2. Verify VPN is connected to Brazil:
   curl -s https://polymarket.com/api/geoblock | cat
   This MUST return {"blocked":false}. If blocked is true, STOP and tell me
   to connect NordVPN to Brazil.

3. Kill any existing btc-trader processes:
   pkill -f "btc-trader/index.ts" 2>/dev/null; sleep 2

4. Start the BTC trader:
   cd ~/projects/btc-trader && nohup npm run btc:start > logs/btc-trader.log 2>&1 &

5. Wait 30 seconds, then verify it started:
   tail -30 ~/projects/btc-trader/logs/btc-trader.log

6. Confirm you see:
   - "BTC 5-Minute Trading Daemon starting..."
   - "Binance BTC/USDT WebSocket connected"
   - "BTC price: $XXXXX.XX"
   - A startup notification mentioning balance and adapter

7. Check state:
   cat ~/projects/btc-trader/state/btc-trading-state.json

Report back with:
- VPN status (blocked or not, country)
- Balance (available USDC.e)
- Daemon status (running or failed to start)
- First trade decision (if a window has been processed)
- Any redeemable positions (remind me to claim at polymarket.com/portfolio)

The bot will now trade autonomously every 5 minutes. Monitor it per AGENTS.md.
```

---

## Mid-Day Check

Send this periodically (or if Discord notifications stop):

```
Check on the BTC trader bot. Is it still running?
1. ps aux | grep "btc-trader" | grep -v grep
2. cat ~/projects/btc-trader/state/btc-system-health.json
3. tail -20 ~/projects/btc-trader/logs/btc-trader.log
4. If it's down, restart it per the startup procedure in AGENTS.md
5. Check balance and report
6. If balance is below $3, remind me to claim winnings at polymarket.com/portfolio
```

---

## Stop

```
Stop the BTC trader bot.
1. kill $(cat ~/projects/btc-trader/state/btc-trader.pid) 2>/dev/null
2. pkill -f "btc-trader/index.ts" 2>/dev/null
3. Confirm no btc-trader processes are running: ps aux | grep "btc-trader" | grep -v grep
4. Report final balance
```
