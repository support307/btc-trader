# Run Strategy V4 (Microstructure Edge)

Copy-paste this entire block into OpenClaw. It handles everything: clone, setup, cleanup, and start.

```
Set up and run the BTC trader with Strategy V4 (Microstructure Edge).

Do every step in order. Do not skip any.

1. Read these docs for context:
   - ~/projects/btc-trader/openclaw/MEMORY.md
   - ~/projects/btc-trader/openclaw/AGENTS.md
   - ~/projects/btc-trader/STRATEGY_V4.md

2. Pull latest code and install dependencies:
   cd ~/projects/btc-trader && git pull && npm install
   If the directory doesn't exist, clone it first:
   cd ~/projects && git clone git@github.com:support307/btc-trader.git && cd btc-trader && npm install

3. Verify tsx works:
   npx tsx --version

4. Check if Polymarket CLI is installed:
   which polymarket
   If NOT found, install it: npm install -g @polymarket/cli
   Then verify: which polymarket

5. Create required directories:
   mkdir -p ~/projects/btc-trader/logs ~/projects/btc-trader/state

6. Verify .env exists:
   ls -la ~/projects/btc-trader/.env
   If missing: cp ~/projects/btc-trader/.env.example ~/projects/btc-trader/.env
   Then STOP and tell me to fill in the keys.

7. Verify Polymarket wallet:
   polymarket wallet show
   If not configured, STOP and tell me.

8. Verify VPN is connected to Brazil:
   curl -s https://polymarket.com/api/geoblock | cat
   Must return {"blocked":false}. If blocked, STOP and tell me to connect NordVPN to Brazil.

9. Kill ALL existing btc-trader processes (full zombie cleanup):
   kill $(cat ~/projects/btc-trader/state/btc-trader.pid 2>/dev/null) 2>/dev/null
   pkill -f "btc-trader/index.ts" 2>/dev/null
   sleep 2
   Verify nothing running: ps aux | grep "btc-trader" | grep -v grep

10. Start V4 in background:
    cd ~/projects/btc-trader && nohup npm run btc:start:v4 > logs/btc-trader.log 2>&1 &

11. Wait 30 seconds, then verify startup:
    tail -30 ~/projects/btc-trader/logs/btc-trader.log
    Confirm you see:
    - "Strategy: ensemble-v4 (v4)"
    - "Binance L2 order book feed started (V4 microstructure)"
    - "Binance L2 book synced (XX bids, XX asks)"
    - "Adapter: polymarket" (NOT dry-run)
    - "Binance BTC/USDT WebSocket connected"
    - "BTC price: $XXXXX"
    If it says dry-run, go back and fix Polymarket CLI / wallet.

12. Check state:
    cat ~/projects/btc-trader/state/btc-trading-state.json

Report back with:
- VPN status
- Strategy: V4
- Adapter (polymarket or dry-run)
- Balance
- Daemon PID
- L2 book sync status
- Any issues

V4 uses Binance L2 order book microstructure (OFI, trade flow, microprice, depth, volume surge, VWAP).
No AI API calls -- zero latency overhead, zero extra cost.
V4 evaluates at 60s, 120s, 180s, 240s, 270s into each 5-minute window.
V4 requires 3+ of 6 microstructure signals agreeing to trade.
V4 uses proportional Kelly sizing (10-50% of bankroll).
V4 logs go to logs/btc-cycles.jsonl and Discord.
Monitor per AGENTS.md.
```
