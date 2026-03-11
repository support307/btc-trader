# Options Trading Streamer

Real-time WebSocket streamer for 0DTE options trading. Watches `trading-state.json` for entry signals, streams live quotes via Alpaca OPRA feed, and executes trades with sub-second precision.

## How It Works

```
OpenClaw Cron (Discord monitor) → writes pendingEntry to state file
                                          ↓
Streamer (this service) → detects pendingEntry → subscribes to quotes
                                          ↓
                              Ask ≤ 1.5x signal price → BUY
                                          ↓
                              Monitors position via WebSocket
                                          ↓
                              Trailing stops / exit logic
```

## Setup

```bash
cd streamer
npm install
```

### Configuration

Create `../.alpaca-live-keys` (parent directory):
```
APCA_API_KEY_ID=your_key_here
APCA_API_SECRET_KEY=your_secret_here
APCA_BASE_URL=https://api.alpaca.markets
```

For paper trading, use:
```
APCA_BASE_URL=https://paper-api.alpaca.markets
```

### Running

```bash
# Direct
node index.js

# Via launchd (macOS) — see launchd template below
```

### macOS LaunchAgent

Save as `~/Library/LaunchAgents/com.discord-trader.streamer.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.discord-trader.streamer</string>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/node</string>
        <string>/path/to/discord-trader/streamer/index.js</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/path/to/discord-trader/streamer/streamer.log</string>
    <key>StandardErrorPath</key>
    <string>/path/to/discord-trader/streamer/streamer.log</string>
</dict>
</plist>
```

Then:
```bash
launchctl load ~/Library/LaunchAgents/com.discord-trader.streamer.plist
```

## Trading Parameters

| Parameter | Value | Description |
|-----------|-------|-------------|
| BUDGET_PCT | 0.25 | 25% of portfolio per trade |
| MAX_ENTRY_MULTIPLIER | 1.5 | Skip if ask > 1.5x signal price |
| TRAILING_ACTIVATE_PCT | 0.75 | Activate trailing at +75% |
| TRAILING_150_PCT | 1.50 | Raise floor at +150% |
| TRAILING_250_PCT | 2.50 | Sell half at +250% |
| HARD_STOP_PCT | -0.60 | Close all at -60% |

## Dependencies

- `ws` — WebSocket client
- `msgpack-lite` — Alpaca stream message decoding
