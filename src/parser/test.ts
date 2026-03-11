// Set required env vars before any imports
process.env.DISCORD_BOT_TOKEN = 'test';
process.env.DISCORD_CHANNEL_ID = 'test';
process.env.ALPACA_API_KEY = 'test';
process.env.ALPACA_API_SECRET = 'test';
process.env.LOG_LEVEL = 'error';

import { SignalParser } from './signal-parser';

const testMessages = [
  '2/11 $IWM Put at $265 at 0.12',
  '@everyone $SPY Call 580 @ 1.25',
  '$TSLA 250P at 0.45',
  'Buy $QQQ 490C for 0.80',
  '$AAPL Put $230 0.55 stop at 0.30 target 1.50',
  'Good morning everyone! Here is the gameplan for today.',
  '$IWM Call at $220 at 0.15 and $SPY Put at $575 at 0.30',
];

console.log('=== Signal Parser Tests ===\n');
for (const msg of testMessages) {
  const result = SignalParser.parse(msg, 'test-' + Math.random().toString(36).slice(2, 8));
  console.log(`Input:  "${msg}"`);
  if (result.success) {
    for (const s of result.signals) {
      console.log(`  ✅ ${s.ticker} ${s.direction.toUpperCase()} Strike:$${s.strikePrice} Entry:$${s.entryPrice}` +
        (s.stopLoss ? ` SL:$${s.stopLoss}` : '') +
        (s.target ? ` TP:$${s.target}` : '') +
        (s.expiration ? ` Exp:${s.expiration}` : ''));
    }
  } else {
    console.log(`  ❌ No signal found${result.errors.length ? ': ' + result.errors[0] : ''}`);
  }
  console.log();
}
