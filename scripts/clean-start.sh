#!/bin/bash
# Kill all zombie discord-trader processes and start fresh

echo "=== Discord Trader Clean Start ==="

# Stop any PM2-managed discord-trader
pm2 stop discord-trader 2>/dev/null
pm2 delete discord-trader 2>/dev/null

# Kill any orphaned node processes running our code
pkill -f "tsx.*src/index.ts" 2>/dev/null
pkill -f "node.*dist/index.js" 2>/dev/null
pkill -f "tsx.*watch.*src/index.ts" 2>/dev/null
pkill -f "streamer/index.js" 2>/dev/null

sleep 1

# Verify nothing is still running
REMAINING=$(pgrep -f "discord-trader" 2>/dev/null | wc -l | tr -d ' ')
if [ "$REMAINING" -gt "1" ]; then
  echo "WARNING: $REMAINING discord-trader processes still running. Force killing..."
  pkill -9 -f "src/index.ts" 2>/dev/null
  pkill -9 -f "streamer/index.js" 2>/dev/null
  sleep 1
fi

# Cancel all open Alpaca orders as safety measure
echo "Cancelling any open Alpaca orders..."
cd "$(dirname "$0")/.." || exit 1
npx tsx -e "
const { AlpacaClient } = require('./src/alpaca/client');
const { config } = require('./src/config');
const client = new AlpacaClient(config.alpaca.baseUrl, config.alpaca.apiKey, config.alpaca.apiSecret);
client.cancelAllOrders().then(() => console.log('Open orders cancelled')).catch(e => console.log('No orders to cancel:', e.message));
" 2>/dev/null || echo "(order cancel skipped — build may be needed)"

# Start fresh with PM2
echo "Starting daemon..."
pm2 start ecosystem.config.js
pm2 save

echo "=== Clean start complete ==="
pm2 status
