# OpenClaw Prompts for BTC Trader

---

## Clean Start

One prompt to rule them all. Paste this into OpenClaw to pull latest code, install deps, kill zombies, verify everything, and start the bot fresh. Safe to run on a brand new machine or for the 100th restart.

```
Clean start the BTC 5-minute trading bot.

Please follow these steps in order:

1. Read your operating docs:
   - ~/projects/btc-trader/openclaw/MEMORY.md
   - ~/projects/btc-trader/openclaw/AGENTS.md

2. Pull latest code:
   cd ~/projects/btc-trader && git pull

3. Install/update dependencies:
   cd ~/projects/btc-trader && npm install
   Verify tsx works: npx tsx --version

4. Check if Polymarket CLI is installed:
   which polymarket
   If NOT found, install it:
   npm install -g @polymarket/cli
   Then verify: which polymarket

5. Create required directories (safe to re-run):
   mkdir -p ~/projects/btc-trader/logs
   mkdir -p ~/projects/btc-trader/state

6. Verify .env exists and has required keys:
   ls -la ~/projects/btc-trader/.env
   If missing: cp ~/projects/btc-trader/.env.example ~/projects/btc-trader/.env
   Then check it contains:
   - POLYMARKET_PRIVATE_KEY (starts with 0x)
   - DISCORD_WEBHOOK_URL
   - GROK_API_KEY
   - BTC_DRY_RUN=false
   - BTC_EXECUTION_ADAPTER=polymarket
   If any key is missing or placeholder, STOP and tell me which keys need to be filled in.

7. Verify Polymarket wallet:
   polymarket wallet show
   Should show wallet address. If not configured, STOP and tell me to set up the wallet.

8. Verify VPN is connected to Brazil:
   curl -s https://polymarket.com/api/geoblock | cat
   Must return {"blocked":false}. If blocked is true, STOP and tell me to connect NordVPN to Brazil.

9. Kill ALL existing btc-trader processes (full zombie cleanup):
   kill $(cat ~/projects/btc-trader/state/btc-trader.pid 2>/dev/null) 2>/dev/null
   pkill -f "btc-trader/index.ts" 2>/dev/null
   sleep 2
   Confirm nothing is running: ps aux | grep "btc-trader" | grep -v grep

10. Start the bot in background (choose a strategy):
    For V1 (original ensemble):
    cd ~/projects/btc-trader && nohup npm run btc:start:v1 > logs/btc-trader.log 2>&1 &
    For V2 (late-window sniper -- fewer trades, bigger bets, cheap tokens only):
    cd ~/projects/btc-trader && nohup npm run btc:start:v2 > logs/btc-trader.log 2>&1 &
    If unsure, ask which strategy to use. See STRATEGY_V2.md for details.

11. Wait 30 seconds, then verify startup:
    tail -30 ~/projects/btc-trader/logs/btc-trader.log
    Confirm you see:
    - "BTC 5-Minute Trading Daemon starting..."
    - "Binance BTC/USDT WebSocket connected"
    - "BTC price: $XXXXX.XX"
    - Adapter: polymarket (NOT dry-run)
    If it says dry-run, go back and fix Polymarket CLI / wallet.

12. Check state and balance:
    cat ~/projects/btc-trader/state/btc-trading-state.json

Report back with:
- Git pull result (already up to date, or files changed)
- npm install result (up to date, or packages added)
- Polymarket CLI status (installed, version)
- VPN status (blocked or not, country)
- Strategy (v1 ensemble or v2 sniper)
- Adapter (polymarket or dry-run)
- Balance (available USDC.e)
- Daemon status (running, PID)
- Any redeemable positions (remind me to claim at polymarket.com/portfolio)
- Any issues encountered

The bot will now trade autonomously every 5 minutes. Monitor per AGENTS.md.
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
