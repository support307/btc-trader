#!/usr/bin/env node
/**
 * Options Trading Streamer — Guru-Follow Mode
 * 
 * Real-time WebSocket streaming for option quotes via Alpaca.
 * Watches trading-state.json for entry signals and guru exit signals.
 * 
 * Exit logic: Guru-driven exits via state file + 12:30 PM EOD close.
 * NO hard stops. NO daily loss halt. NO trailing stops. NO time-based exits.
 */

const WebSocket = require('ws');
const msgpack = require('msgpack-lite');
const fs = require('fs');
const https = require('https');
const path = require('path');

// ─── Config ───
const envPath = path.join(__dirname, '..', '.alpaca-live-keys');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const [key, ...val] = line.split('=');
    if (key && val.length) process.env[key.trim()] = val.join('=').trim();
  });
}

const ALPACA_KEY = process.env.APCA_API_KEY_ID || '';
const ALPACA_SECRET = process.env.APCA_API_SECRET_KEY || '';
const ALPACA_BASE = process.env.APCA_BASE_URL || 'https://api.alpaca.markets';
const STREAM_URL = process.env.STREAM_URL || 'wss://stream.data.alpaca.markets/v1beta1/opra';
const STATE_PATH = process.env.STATE_PATH || path.join(__dirname, '..', 'state', 'trading-state.json');
const LOG_PATH = process.env.LOG_PATH || path.join(__dirname, 'streamer.log');

// Only 12:40 PM EOD close. No hard stops. No daily loss halt.
const FORCE_CLOSE_HOUR = 12;
const FORCE_CLOSE_MINUTE = 40;

// ─── State ───
let state = null;
let ws = null;
let subscribedSymbol = null;
let lastQuote = null;
let reconnectAttempts = 0;
let isAuthenticated = false;
let sellInProgress = false;

// ─── Logging ───
function log(msg) {
  const ts = new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_PATH, line + '\n');
  } catch (e) {}
}

// ─── State Management ───
function readState() {
  try {
    const raw = fs.readFileSync(STATE_PATH, 'utf8');
    state = JSON.parse(raw);
    return state;
  } catch (e) {
    log(`Error reading state: ${e.message}`);
    return null;
  }
}

function writeState(newState) {
  state = newState;
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// ─── Alpaca REST API ───
function alpacaRequest(method, endpoint, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, ALPACA_BASE);
    const options = {
      method,
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers: {
        'APCA-API-KEY-ID': ALPACA_KEY,
        'APCA-API-SECRET-KEY': ALPACA_SECRET,
        'Content-Type': 'application/json',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: data ? JSON.parse(data) : null });
        } catch (e) {
          resolve({ status: res.statusCode, data: data });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function getAccount() {
  const res = await alpacaRequest('GET', '/v2/account');
  return res.data;
}

async function submitOrder(symbol, qty, side) {
  log(`ORDER: ${side} ${qty}x ${symbol}`);
  const res = await alpacaRequest('POST', '/v2/orders', {
    symbol,
    qty: String(qty),
    side,
    type: 'market',
    time_in_force: 'day',
  });
  log(`ORDER RESPONSE: ${res.status} - ${JSON.stringify(res.data)}`);
  return res;
}

// ─── WebSocket Streaming ───
function connectStream() {
  log('Connecting to Alpaca options stream...');
  
  ws = new WebSocket(STREAM_URL);
  ws.binaryType = 'arraybuffer';
  
  ws.on('open', () => {
    log('WebSocket connected, authenticating...');
    reconnectAttempts = 0;
    const authMsg = msgpack.encode({ action: 'auth', key: ALPACA_KEY, secret: ALPACA_SECRET });
    ws.send(authMsg);
  });

  ws.on('message', (rawData) => {
    try {
      const messages = msgpack.decode(Buffer.from(rawData));
      const msgs = Array.isArray(messages) ? messages : [messages];
      for (const msg of msgs) {
        handleMessage(msg);
      }
    } catch (e) {
      try {
        const msgs = JSON.parse(rawData.toString());
        const arr = Array.isArray(msgs) ? msgs : [msgs];
        for (const msg of arr) handleMessage(msg);
      } catch (e2) {
        log(`Parse error: ${e.message}`);
      }
    }
  });

  ws.on('close', (code, reason) => {
    log(`WebSocket closed: ${code} ${reason}`);
    isAuthenticated = false;
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    log(`WebSocket error: ${err.message}`);
  });
}

function handleMessage(msg) {
  if (!msg || !msg.T) return;

  switch (msg.T) {
    case 'success':
      if (msg.msg === 'connected') {
        log('Stream connected');
      } else if (msg.msg === 'authenticated') {
        log('Authenticated to options stream');
        isAuthenticated = true;
        if (subscribedSymbol) {
          subscribeToSymbol(subscribedSymbol);
        }
      }
      break;

    case 'error':
      log(`Stream error: ${msg.code} - ${msg.msg}`);
      break;

    case 'q':
      handleQuote(msg);
      break;

    case 't':
      handleTrade(msg);
      break;
  }
}

function subscribeToSymbol(symbol) {
  if (!ws || ws.readyState !== WebSocket.OPEN || !isAuthenticated) {
    log(`Cannot subscribe to ${symbol} - not connected/authenticated`);
    return;
  }

  if (subscribedSymbol && subscribedSymbol !== symbol) {
    const unsub = msgpack.encode({
      action: 'unsubscribe',
      quotes: [subscribedSymbol],
      trades: [subscribedSymbol],
    });
    ws.send(unsub);
  }

  log(`Subscribing to ${symbol}`);
  const sub = msgpack.encode({
    action: 'subscribe',
    quotes: [symbol],
    trades: [symbol],
  });
  ws.send(sub);
  subscribedSymbol = symbol;
}

function unsubscribeAll() {
  if (subscribedSymbol && ws && ws.readyState === WebSocket.OPEN) {
    const unsub = msgpack.encode({
      action: 'unsubscribe',
      quotes: [subscribedSymbol],
      trades: [subscribedSymbol],
    });
    ws.send(unsub);
    subscribedSymbol = null;
    lastQuote = null;
  }
}

function scheduleReconnect() {
  reconnectAttempts++;
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
  log(`Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
  setTimeout(connectStream, delay);
}

// ─── Quote/Trade Handling ───
function handleQuote(q) {
  lastQuote = {
    symbol: q.S,
    bid: q.bp,
    ask: q.ap,
    bidSize: q.bs,
    askSize: q.as,
    time: q.t,
  };

  processQuote(lastQuote);
}

function handleTrade(t) {
  const tradePrice = t.p;
  const st = readState();
  if (!st) return;

  const pos = Object.values(st.positions || {})[0];
  if (pos && pos.entryPrice) {
    const pctChange = (tradePrice - pos.entryPrice) / pos.entryPrice;
    if (Math.abs(pctChange) > 0.20) {
      log(`Trade tick: ${t.S} @ $${tradePrice} (${(pctChange * 100).toFixed(1)}% from entry)`);
    }
  }
}

// ─── Core Trading Logic (Guru-Follow) ───
// Entry is handled exclusively by the main daemon (guru-trade-manager).
// The streamer only handles EOD close as a safety net.
async function processQuote(quote) {
  const st = readState();
  if (!st) return;

  const pos = Object.values(st.positions || {})[0];
  
  if (pos && pos.entryPrice) {
    await processExits(st, pos, quote);
  }
}

/**
 * Exit logic: ONLY 12:30 PM EOD close.
 * No hard stops. No daily loss halt. No trailing stops. No time-based exits.
 * Guru exits are handled by the main process (guru-trade-manager) directly.
 * The streamer is just a safety net for EOD close.
 */
async function processExits(st, pos, quote) {
  if (quote.symbol !== pos.symbol) return;
  if (sellInProgress) return;

  const freshState = readState();
  if (!freshState || Object.keys(freshState.positions || {}).length === 0) return;

  const now = new Date();
  const pst = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  if (pst.getHours() > FORCE_CLOSE_HOUR ||
      (pst.getHours() === FORCE_CLOSE_HOUR && pst.getMinutes() >= FORCE_CLOSE_MINUTE)) {
    log('12:30 PM PST — FORCE CLOSE ALL');
    await sellAll(freshState, freshState.positions[Object.keys(freshState.positions)[0]], 'eod-close');
    return;
  }
}

async function sellAll(st, pos, reason) {
  if (sellInProgress) {
    log('Sell already in progress — skipping duplicate');
    return;
  }
  sellInProgress = true;

  try {
    await submitOrder(pos.symbol, pos.qty, 'sell');

    if (!st.closedToday) st.closedToday = [];
    st.closedToday.push({
      symbol: pos.symbol,
      qty: pos.qty,
      entryPrice: pos.entryPrice,
      exitReason: reason,
      exitTime: new Date().toISOString(),
    });

    delete st.positions[pos.symbol];
    unsubscribeAll();
    writeState(st);

    log(`Position closed (${reason}). Unsubscribed from stream.`);
  } catch (err) {
    log(`Sell failed: ${err.message}`);
  } finally {
    sellInProgress = false;
  }
}

// ─── State File Watcher ───
// Only watches for active positions (to stream quotes for EOD close).
// Entry logic is handled entirely by the main daemon.
function watchState() {
  setInterval(() => {
    const st = readState();
    if (!st) return;

    const pos = Object.values(st.positions || {})[0];
    if (pos && pos.symbol && pos.symbol !== subscribedSymbol) {
      log(`Active position detected: ${pos.symbol}`);
      subscribeToSymbol(pos.symbol);
    }

    if (!pos && subscribedSymbol) {
      log('No active position. Unsubscribing.');
      unsubscribeAll();
    }
  }, 1000);
}

// ─── Market Hours Check ───
function isMarketHours() {
  const now = new Date();
  const pst = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const day = pst.getDay();
  const hour = pst.getHours();
  const min = pst.getMinutes();
  
  if (day === 0 || day === 6) return false;
  if (hour < 6 || (hour === 6 && min < 25)) return false;
  if (hour >= 13) return false;
  return true;
}

// ─── Main ───
async function main() {
  log('═══════════════════════════════════════');
  log('Options Trading Streamer (Guru-Follow Mode)');
  log('═══════════════════════════════════════');
  log('Exit rules: Guru signal or 12:30 PM EOD only. No hard stops.');
  log('All exits driven by guru signals via state file + EOD force close');

  readState();
  log(`State: mode=${state?.mode}, positions=${Object.keys(state?.positions || {}).length}`);

  connectStream();
  watchState();

  // Periodic status log
  setInterval(() => {
    const st = readState();
    if (!st) return;
    const pos = Object.values(st.positions || {})[0];
    if (pos && lastQuote) {
      const pct = ((lastQuote.bid - pos.entryPrice) / pos.entryPrice * 100).toFixed(1);
      log(`Status: ${pos.symbol} entry=$${pos.entryPrice} bid=$${lastQuote.bid} ask=$${lastQuote.ask} (${pct}%) halfSold=${pos.halfSold || false}`);
    }
  }, 30000);

  log('Streamer ready. Watching state file for signals...');
}

main().catch((e) => {
  log(`Fatal error: ${e.message}`);
  process.exit(1);
});
