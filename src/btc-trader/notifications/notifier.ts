import { logger } from '../clock/logger';
import { btcConfig } from '../config';
import { StrategyDecision, FeatureVector, TradeResult } from '../types';

export type BtcNotificationType =
  | 'TRADE_ENTRY'
  | 'TRADE_FILL'
  | 'TRADE_SKIP'
  | 'WINDOW_RESOLVED'
  | 'DAILY_SUMMARY'
  | 'SYSTEM_STATUS'
  | 'ERROR';

const EMBED_COLORS: Record<BtcNotificationType, number> = {
  TRADE_ENTRY: 0x2ecc71,    // green
  TRADE_FILL: 0x3498db,     // blue
  TRADE_SKIP: 0x95a5a6,     // gray
  WINDOW_RESOLVED: 0x9b59b6, // purple (overridden per win/loss below)
  DAILY_SUMMARY: 0x1abc9c,  // teal
  SYSTEM_STATUS: 0x95a5a6,  // gray
  ERROR: 0xe74c3c,          // red
};

const COLOR_WIN = 0x2ecc71;   // green
const COLOR_LOSS = 0xe74c3c;  // red

const MAX_RETRIES = 3;

interface WebhookEmbed {
  title?: string;
  description: string;
  color: number;
  footer: { text: string };
  timestamp: string;
}

async function sendWebhook(embed: WebhookEmbed): Promise<void> {
  const webhookUrl = btcConfig.notifications.discordWebhookUrl;
  if (!webhookUrl) return;

  const payload = { embeds: [embed] };

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok || res.status === 204) return;
      if (res.status === 429) {
        const body: any = await res.json().catch(() => ({}));
        await new Promise((r) => setTimeout(r, (body.retry_after ?? 2) * 1000));
        continue;
      }
    } catch (err: any) {
      logger.warn(`BTC webhook attempt ${attempt}: ${err.message}`);
    }
    if (attempt < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

function send(type: BtcNotificationType, title: string, description: string, colorOverride?: number): void {
  const line = `${title} -- ${description.replace(/\n/g, ' | ')}`;
  console.log(`[BTC-NOTIFY] ${line}`);
  logger.info(`BTC Notification (${type}): ${line}`);
  sendWebhook({
    title,
    description: description.substring(0, 4096),
    color: colorOverride ?? EMBED_COLORS[type] ?? 0x95a5a6,
    footer: { text: btcConfig.notifications.strategyLabel },
    timestamp: new Date().toISOString(),
  }).catch((err) => {
    logger.error(`BTC webhook failed: ${err.message}`);
  });
}

export function btcNotify(type: BtcNotificationType, message: string): void {
  send(type, type.replace(/_/g, ' '), message);
}

// ---------------------------------------------------------------------------
// Entry: when the ensemble decides to trade (before order is placed)
// ---------------------------------------------------------------------------
export function notifyDecision(
  decision: StrategyDecision,
  features: FeatureVector,
  orderPrice: number,
  orderSize: number,
  subDecisions?: StrategyDecision[],
  balanceBefore?: number,
): void {
  if (decision.direction === 'abstain') return;

  const strategy = btcConfig.trading.strategy;
  const dir = decision.direction.toUpperCase();
  const conf = (decision.confidence * 100).toFixed(0);
  const ret1m = features.btcReturn1m;
  const ret5m = features.btcReturn5m;
  const cost = (orderSize * orderPrice).toFixed(2);
  const kelly = decision.suggestedSize ?? 0;

  let voters = '';
  if (subDecisions) {
    const active = subDecisions.filter((d) => d.direction !== 'abstain');
    voters = active
      .map((d) => `${d.strategy} ${d.direction === decision.direction ? '' : '(' + d.direction + ') '}${(d.confidence * 100).toFixed(0)}%`)
      .join(', ');
  }

  const lines = [
    `**Strategy: ${strategy.toUpperCase()}** | BTC $${features.btcPrice.toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
    `Ret: 1m ${ret1m >= 0 ? '+' : ''}${(ret1m * 100).toFixed(4)}% | 5m ${ret5m >= 0 ? '+' : ''}${(ret5m * 100).toFixed(4)}%`,
    `Market: up ${(features.impliedProbUp * 100).toFixed(1)}% / down ${(features.impliedProbDown * 100).toFixed(1)}% | Vol: ${(features.btcVolatility5m * 10000).toFixed(1)}bps`,
    `Token: $${orderPrice.toFixed(3)} | ${Math.round(orderSize)} tokens | Cost: $${cost} | Kelly: ${(kelly * 100).toFixed(1)}%`,
    `Window: ${features.secondsIntoWindow}s in | ${300 - features.secondsIntoWindow}s remaining`,
  ];
  if (balanceBefore !== undefined) {
    lines.push(`Balance before: $${balanceBefore.toFixed(2)} | Bet: ${((parseFloat(cost) / balanceBefore) * 100).toFixed(1)}% of bankroll`);
  }
  if (voters) lines.push(`Signals: ${voters}`);

  send('TRADE_ENTRY', `[${strategy.toUpperCase()}] BUY ${dir} | ${conf}% conf`, lines.join('\n'));
}

// ---------------------------------------------------------------------------
// Fill: after order is confirmed filled
// ---------------------------------------------------------------------------
export function notifyFill(result: TradeResult): void {
  const strategy = btcConfig.trading.strategy;
  if (!result.filled) {
    send('ERROR', `[${strategy.toUpperCase()}] ORDER FAILED`, `${result.order.direction.toUpperCase()} order did not fill`);
    return;
  }
  const dir = result.order.direction.toUpperCase();
  const cost = (result.fillSize * result.fillPrice).toFixed(2);
  const fee = result.fee > 0 ? ` | Fee: $${result.fee.toFixed(2)}` : '';
  const payout = result.fillSize.toFixed(2);
  const payoutRatio = (1 / result.fillPrice).toFixed(2);
  send(
    'TRADE_FILL',
    `[${strategy.toUpperCase()}] FILLED ${dir}`,
    `${Math.round(result.fillSize)} tokens @ $${result.fillPrice.toFixed(2)} ($${cost})${fee}\nIf win: payout $${payout} (${payoutRatio}x return)`,
  );
}

// ---------------------------------------------------------------------------
// Skip: when we evaluate a window and abstain (first checkpoint only)
// ---------------------------------------------------------------------------
export function notifySkip(features: FeatureVector, reason: string, subDecisions?: StrategyDecision[]): void {
  const strategy = btcConfig.trading.strategy;
  const ret1m = features.btcReturn1m;
  const ret5m = features.btcReturn5m;

  const shortReason = reason.length > 200 ? reason.substring(0, 200) + '...' : reason;

  let signalSummary = '';
  if (subDecisions) {
    const fired = subDecisions.filter((d) => d.direction !== 'abstain');
    const abstained = subDecisions.filter((d) => d.direction === 'abstain');
    if (fired.length > 0) {
      signalSummary = `\nFired: ${fired.map((d) => `${d.strategy} ${d.direction} ${(d.confidence * 100).toFixed(0)}%`).join(', ')}`;
    }
    signalSummary += `\nAbstained: ${abstained.map((d) => d.strategy).join(', ')}`;
  }

  const lines = [
    `1m ${ret1m >= 0 ? '+' : ''}${(ret1m * 100).toFixed(4)}% | 5m ${ret5m >= 0 ? '+' : ''}${(ret5m * 100).toFixed(4)}%`,
    `Market: up ${(features.impliedProbUp * 100).toFixed(1)}% / down ${(features.impliedProbDown * 100).toFixed(1)}% | ${features.secondsIntoWindow}s in`,
    `Reason: ${shortReason}`,
  ];
  if (signalSummary) lines.push(signalSummary.trim());

  send(
    'TRADE_SKIP',
    `[${strategy.toUpperCase()}] SKIP | BTC $${features.btcPrice.toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
    lines.join('\n'),
  );
}

// ---------------------------------------------------------------------------
// Resolution: when a window resolves and we know if we won or lost
// ---------------------------------------------------------------------------
export function notifyResolution(opts: {
  direction: 'up' | 'down';
  entryPrice: number;
  size: number;
  outcome: 'up' | 'down';
  pnl: number;
  balance: number;
  todayWins: number;
  todayLosses: number;
  todayPnl: number;
}): void {
  const strategy = btcConfig.trading.strategy;
  const won = opts.direction === opts.outcome;
  const cost = (opts.entryPrice * opts.size).toFixed(2);
  const payout = won ? opts.size.toFixed(2) : '0.00';
  const pnlSign = opts.pnl >= 0 ? '+' : '';
  const payoutRatio = won ? (1 / opts.entryPrice).toFixed(2) : '0.00';
  const totalTrades = opts.todayWins + opts.todayLosses;
  const winRate = totalTrades > 0 ? ((opts.todayWins / totalTrades) * 100).toFixed(0) : '0';

  const title = won
    ? `[${strategy.toUpperCase()}] WIN | ${opts.direction.toUpperCase()} @ $${opts.entryPrice.toFixed(2)}`
    : `[${strategy.toUpperCase()}] LOSS | ${opts.direction.toUpperCase()} @ $${opts.entryPrice.toFixed(2)}`;

  const lines = [
    `Outcome: **${opts.outcome.toUpperCase()}** | P&L: **${pnlSign}$${opts.pnl.toFixed(2)}**`,
    `Cost: $${cost} | Payout: $${payout}${won ? ` (${payoutRatio}x)` : ''}`,
    `Balance: **$${opts.balance.toFixed(2)}** | Today: ${opts.todayWins}W/${opts.todayLosses}L (${winRate}% WR, ${opts.todayPnl >= 0 ? '+' : ''}$${opts.todayPnl.toFixed(2)})`,
  ];

  send('WINDOW_RESOLVED', title, lines.join('\n'), won ? COLOR_WIN : COLOR_LOSS);
}

// ---------------------------------------------------------------------------
// Daily summary
// ---------------------------------------------------------------------------
export function notifyDailySummary(stats: {
  windowsProcessed: number;
  windowsTraded: number;
  wins: number;
  losses: number;
  totalPnl: number;
  balance: number;
}): void {
  const strategy = btcConfig.trading.strategy;
  const winRate = stats.windowsTraded > 0
    ? ((stats.wins / stats.windowsTraded) * 100).toFixed(0)
    : '0';
  const tradeRate = stats.windowsProcessed > 0
    ? ((stats.windowsTraded / stats.windowsProcessed) * 100).toFixed(0)
    : '0';
  const pnlSign = stats.totalPnl >= 0 ? '+' : '';
  const avgPnl = stats.windowsTraded > 0
    ? (stats.totalPnl / stats.windowsTraded).toFixed(2)
    : '0.00';

  send(
    'DAILY_SUMMARY',
    `[${strategy.toUpperCase()}] Daily Summary`,
    `Strategy: **${strategy.toUpperCase()}**\n` +
    `Traded ${stats.windowsTraded} of ${stats.windowsProcessed} windows (${tradeRate}% trade rate)\n` +
    `Record: **${stats.wins}W / ${stats.losses}L** (${winRate}% win rate)\n` +
    `P&L: **${pnlSign}$${stats.totalPnl.toFixed(2)}** | Avg: $${avgPnl}/trade\n` +
    `Balance: **$${stats.balance.toFixed(2)}**\n` +
    `Log: logs/btc-cycles-${strategy}.jsonl`,
  );
}
