# OpenClaw Workspace Files

These files configure OpenClaw to manage two independent trading systems:

1. **Discord Guru-Follow** -- 0DTE options on Alpaca, follows a Discord guru's signals (market hours only)
2. **BTC 5-Minute Trader** -- autonomous Polymarket bets on Bitcoin direction every 5 minutes (24/7)

## Setup

Copy these files to your OpenClaw workspace:

```bash
mkdir -p ~/.openclaw/workspace

cp openclaw/MEMORY.md ~/.openclaw/workspace/MEMORY.md
cp openclaw/AGENTS.md ~/.openclaw/workspace/AGENTS.md
cp openclaw/SOUL.md ~/.openclaw/workspace/SOUL.md
```

If you already have existing AGENTS.md or SOUL.md files in your workspace, merge the trading-specific sections into your existing files.

## What Each File Does

| File | Purpose | OpenClaw Reads |
|------|---------|----------------|
| `MEMORY.md` | Long-term facts for both systems: accounts, strategies, parameters, limitations, lessons learned | Every session start |
| `AGENTS.md` | Operating instructions for both systems: start/stop, monitor, crash recovery, claiming winnings | Every session start |
| `SOUL.md` | Persona and tone for both systems: reporting style, risk framing, boundaries | Every session start |
| `DAILY-START.md` | Copy-paste startup messages for each system (not loaded automatically -- used by you) | On demand |

## Quick Reference: What OpenClaw Can Do

### Discord Guru-Follow

- "Start the trading daemon" -- runs preflight + clean-start
- "How's our portfolio?" -- checks Alpaca equity and positions
- "What did the guru say today?" -- reviews classification log
- "Close all positions" -- force-closes via Alpaca
- "Run the simulation test" -- runs test suite

### BTC 5-Minute Trader

- "Start the BTC trader" -- verifies VPN, starts daemon, reports balance
- "How's the BTC bot doing?" -- checks health file and process status
- "Stop the BTC trader" -- kills process cleanly
- "What's our Polymarket balance?" -- runs status command
- "Check for winnings to claim" -- checks redeemable positions

### What OpenClaw CANNOT Do

- **Claim Polymarket winnings** -- the CLI doesn't support proxy wallet redemption. The user must claim manually at https://polymarket.com/portfolio
- **Connect/disconnect VPN** -- the user must manage NordVPN manually

## Updating

When you make changes to the trading system, re-copy to the workspace:

```bash
cp openclaw/MEMORY.md ~/.openclaw/workspace/MEMORY.md
cp openclaw/AGENTS.md ~/.openclaw/workspace/AGENTS.md
cp openclaw/SOUL.md ~/.openclaw/workspace/SOUL.md
```

Or set up symlinks for automatic updates:

```bash
ln -sf ~/projects/discord-trader/openclaw/MEMORY.md ~/.openclaw/workspace/MEMORY.md
ln -sf ~/projects/discord-trader/openclaw/AGENTS.md ~/.openclaw/workspace/AGENTS.md
ln -sf ~/projects/discord-trader/openclaw/SOUL.md ~/.openclaw/workspace/SOUL.md
```
