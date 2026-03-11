# Trading Strategy -- Guru-Follow Mode (0DTE Options)

## Core Principle

**Follow the guru (Stocksandrealestate) exactly.** He calls entries, he calls exits. We do not override him with autonomous trailing stops, time-based exits, hard stops, or danger-signal sells. The only automated exit is 12:40 PM EOD close (0DTE expiry protection).

## Why This Matters

Previous autonomous exit logic (trailing stops at +50%, 15-min time decay, 30-min timeout, "adding = danger" sells) caused 3 consecutive losing days by exiting positions before the guru's plays could run. On winning days, the guru's trades routinely dip before running 100-250%+. Automated exits killed those runners.

## The Guru's Pattern (Observed 2+ Weeks)

1. **~6:00-6:10 AM PST** -- Posts gameplan: tickers, direction (calls/puts), price ranges
2. **~6:25-6:35 AM PST** -- Entry signal with specific strike + price
3. **~6:35-6:50 AM PST** -- May add to position ("Adding here", "better fill") at same or different strikes
4. **~7:00-7:30 AM PST** -- On winning days: profit call ("sell half", "X% gain", "cooking")
5. **~7:30 AM-12:00 PM PST** -- Additional updates, second exit signals
6. Typical entries: IWM options $0.10-$0.20, SPY options $0.30-$0.50

## Message Classification

Every guru message is classified into one of these types:

| Type | Examples | Bot Action |
|------|----------|------------|
| GAMEPLAN | "Todays gameplan $SPY", "The calls im watching" | Track tickers, notify, NO trade |
| ENTRY | "$IWM Call at $265 at 0.09" (has ticker+strike+price) | BUY at mentioned price |
| SCALE_IN | "Adding here", "better fill" + price | Hold — never buy more, one buy per day only |
| UPDATE | "Decent pump", "Absolutely cooking" | Notify only |
| PARTIAL_EXIT | "Sell half", "take some off", "to be safe" | SELL HALF |
| FULL_EXIT | "Sell all", "close all", "done for the day" | SELL ALL |

## Entry Rules

- Buy immediately when ENTRY signal detected (market order for speed)
- Budget: flat $2,000 per trade (fixed, regardless of account size)
- Max 500 contracts per order
- Skip if ask > 1.5x signal price (something is clearly wrong)
- One position per day -- if already in a trade, subsequent entries treated as scale-in
- Speed matters more than price: guru's plays run 100-250%+

## Exit Rules

### Guru-Driven Exits (Primary)

1. **PARTIAL_EXIT signal** ("sell half", "take profits") -- Sell half, keep runners
2. **Second PARTIAL_EXIT** -- If half already sold, sell all remaining
3. **FULL_EXIT signal** ("sell all", "done for the day") -- Sell everything

### EOD Force Close (Only Automated Exit)

| Condition | Action |
|-----------|--------|
| 12:40 PM PST | Close everything (0DTE expiry protection) |

No -60% hard stop. No daily loss halt. On losing days, we accept the full loss and sell at 12:40 PM. The winning days (100-2000% gains) far outweigh the losers.

### What We Do NOT Do

- NO hard percentage stops -- the guru's trades dip before they run
- NO daily loss halts -- one bad day is worth accepting for the winning days
- NO trailing stops -- the guru's plays involve holding through drawdowns
- NO time-based exits -- trades can take 30-60+ minutes to play out
- NO "adding = danger" sells -- on winning days, "adding" precedes the big move
- NO evaluation scoring -- we trust the guru's signal, period

## About "Adding" Signals

The guru frequently posts "Adding here" or "better fill" during a trade. This is NOT a danger signal. On winning days (which are ~80% of the time), this precedes the real move:

- 3/4 example: Entry at $0.09, "Adding here" at $0.18, eventual peak at $0.71 (+222%)
- The old system would sell on "adding" -- this is exactly wrong

Default behavior: HOLD (don't sell, don't add). Scale-in buying is permanently disabled — one buy per day only.

## Position Sizing

- Flat $2,000 per trade (fixed amount, not a percentage)
- At $0.15/contract = ~133 contracts, at $0.25/contract = ~53 contracts
- Scale-in uses half the normal budget ($1,000)
- Max loss per trade = $2,000 (the premium paid)

## Daily Schedule (All times PST)

| Time | Event |
|------|-------|
| 6:00 AM | System starts, checks account |
| 6:25-7:45 AM | HOT ZONE: Poll Discord every 3s |
| 7:45 AM-12:40 PM | CRUISE: Poll Discord every 10s |
| 12:40 PM | Hard close -- sell everything |
| 1:00 PM | EOD reset |

## Periodic Updates

You get WhatsApp notifications for:
- Every guru message (classified and forwarded)
- Periodic position updates (5 min in hot zone, 15 min in cruise)
- Milestone alerts when the position crosses +50%, +100%, +200%, +300%, +500%, +1000%, -25%, -50%, -75%
- All milestones are informational only -- no sell action taken

## Lessons Learned

- Don't override the guru -- his silence doesn't mean the trade is dead
- "Adding" signals are bullish, not bearish (most of the time)
- Entry price matters less than staying in -- a $0.18 entry on a $0.71 exit is still +294%
- Early peaks are noise -- don't trail stop on a +50% peak, the real move might be +200%+
- The guru always posts when it's time to take profit -- wait for his call
- Paper trading overstates returns by ~20-40% due to slippage
- Accept losing days -- max $2,000 loss on a bad day, gains on good days far outweigh

## Risk Profile

**Winning days (~80% of the time):** Enter at $0.10-$0.20, exit at $0.50-$2.00+ = 100-2000% gain on $2,000.

**Losing days (~20% of the time):** Enter at $0.10-$0.20, option goes to near zero, sell at 12:40 PM = up to -$2,000 loss.

**Expected value per day (rough):** 0.8 * $2,000 * 1.5 (avg 150% gain) + 0.2 * -$2,000 = $2,400 - $400 = +$2,000

The asymmetry is massive: let every winner run to its full potential, accept the occasional full loss.
