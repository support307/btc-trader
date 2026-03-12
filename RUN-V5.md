# Running Strategy V5: Inverse Cramer

## What V5 Does

Every 5 minutes, V5 asks Grok to roleplay as Jim Cramer -- emotional, FOMO-driven, momentum-chasing. Cramer gives his loud confident call on BTC direction. The bot then does the **exact opposite**. When Cramer screams BUY, we sell. When he panics, we buy.

---

## API Keys Required

| Key | Required? | What It Does |
|-----|-----------|-------------|
| `GROK_API_KEY` | **YES** | Powers the Cramer persona + X/Twitter access |
| `POLYMARKET_PRIVATE_KEY` | **YES** | Places trades on Polymarket |
| `DISCORD_WEBHOOK_URL` | **YES** | Trade notifications |

Same keys as V3. No additional keys needed.

---

## Quick Start

### 1. VPN to Brazil

```bash
curl -s https://polymarket.com/api/geoblock | cat
```

### 2. Kill existing bot and start V5

```bash
cd ~/projects/btc-trader
pkill -f "btc-trader/index.ts" 2>/dev/null
sleep 2
nohup npm run btc:start:v5 > logs/btc-trader.log 2>&1 &
```

### 3. Watch the show

```bash
tail -f logs/btc-trader.log
```

You'll see:
```
Strategy: ensemble-v5 (v5)
[CRAMER] Says: UP 85% -- BOOYAH! Bitcoin is RIPPING! This train is leaving the station, BUY BUY BUY!
[INVERSE-CRAMER] We go: DOWN 85%
Decision: down (ensemble-v5, confidence: 0.850) -- Inverse Cramer: down 85% conf. Token: $0.280...
[POLYMARKET] Placing order: down 12 tokens @ $0.28...
```

### 4. Switch to a different strategy

```bash
pkill -f "btc-trader/index.ts" 2>/dev/null; sleep 2
npm run btc:start:v3   # Switch to V3 AI Trader
# or
npm run btc:start:v2   # Switch to V2 Sniper
```

---

## OpenClaw Prompt

```
Clean start the BTC trader with Strategy V5 (Inverse Cramer).

1. Read docs:
   - ~/projects/btc-trader/STRATEGY_V5.md
   - ~/projects/btc-trader/openclaw/AGENTS.md

2. Verify VPN (Brazil):
   curl -s https://polymarket.com/api/geoblock | cat

3. Verify GROK_API_KEY:
   grep GROK_API_KEY ~/projects/btc-trader/.env

4. Kill existing and start V5:
   cd ~/projects/btc-trader
   pkill -f "btc-trader/index.ts" 2>/dev/null; sleep 2
   nohup npm run btc:start:v5 > logs/btc-trader.log 2>&1 &

5. Wait 30s, verify:
   tail -30 ~/projects/btc-trader/logs/btc-trader.log
   Should see: Strategy: ensemble-v5 (v5)
   Should see: [CRAMER] and [INVERSE-CRAMER] log lines

Report: VPN status, balance, strategy version, first Cramer prediction.
```

---

## What to Watch For

- **Cramer says UP, we go DOWN** -- the inversion is working
- **Token prices < $0.55** -- guard rails preventing expensive buys
- **Trades every few minutes** -- V5 should trade much more often than V2
- **Win rate > 50% over time** -- if Cramer is truly a contrarian indicator

---

## Claiming Winnings

Same as always:
1. Go to https://polymarket.com/portfolio
2. Click **Claim** on winning positions
3. Check balance regularly
