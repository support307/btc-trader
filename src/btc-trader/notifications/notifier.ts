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
    footer: { text: 'BTC 5-Min Trader' },
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
): void {
  if (decision.direction === 'abstain') return;

  const dir = decision.direction.toUpperCase();
  const conf = (decision.confidence * 100).toFixed(0);
  const ret = features.btcReturn1m !== 0 ? features.btcReturn1m : features.btcReturn5m;
  const retLabel = features.btcReturn1m !== 0 ? '1m' : '5m';
  const retSign = ret >= 0 ? '+' : '';
  const cost = (orderSize * orderPrice).toFixed(2);

  let voters = '';
  if (subDecisions) {
    const active = subDecisions.filter((d) => d.direction !== 'abstain');
    voters = active
      .map((d) => `${d.strategy} ${d.direction === decision.direction ? '' : '(' + d.direction + ') '}${(d.confidence * 100).toFixed(0)}%`)
      .join(', ');
  }

  const lines = [
    `BTC $${features.btcPrice.toLocaleString('en-US', { maximumFractionDigits: 0 })} | ${retSign}${(ret * 100).toFixed(3)}% (${retLabel}) | ${features.secondsIntoWindow}s into window`,
    `Market: up ${(features.impliedProbUp * 100).toFixed(0)}% / down ${(features.impliedProbDown * 100).toFixed(0)}%`,
    `Cost: $${cost} (${Math.round(orderSize)} tokens @ $${orderPrice.toFixed(2)})`,
  ];
  if (voters) lines.push(`Strategies: ${voters}`);

  send('TRADE_ENTRY', `BUY ${dir} | ${conf}% confidence`, lines.join('\n'));
}

// ---------------------------------------------------------------------------
// Fill: after order is confirmed filled
// ---------------------------------------------------------------------------
export function notifyFill(result: TradeResult): void {
  if (!result.filled) {
    send('ERROR', 'ORDER FAILED', `${result.order.direction.toUpperCase()} order did not fill`);
    return;
  }
  const dir = result.order.direction.toUpperCase();
  const cost = (result.fillSize * result.fillPrice).toFixed(2);
  const fee = result.fee > 0 ? ` | Fee: $${result.fee.toFixed(2)}` : '';
  send(
    'TRADE_FILL',
    `FILLED ${dir}`,
    `${Math.round(result.fillSize)} tokens @ $${result.fillPrice.toFixed(2)} ($${cost})${fee}`,
  );
}

// ---------------------------------------------------------------------------
// Skip: when we evaluate a window and abstain (first checkpoint only)
// ---------------------------------------------------------------------------
export function notifySkip(features: FeatureVector, reason: string): void {
  const ret = features.btcReturn1m !== 0 ? features.btcReturn1m : features.btcReturn5m;
  const retLabel = features.btcReturn1m !== 0 ? '1m' : '5m';
  const retSign = ret >= 0 ? '+' : '';

  const shortReason = reason.length > 120 ? reason.substring(0, 120) + '...' : reason;

  send(
    'TRADE_SKIP',
    `SKIP | BTC $${features.btcPrice.toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
    `${retSign}${(ret * 100).toFixed(3)}% (${retLabel}) | ${features.secondsIntoWindow}s in | up ${(features.impliedProbUp * 100).toFixed(0)}% / down ${(features.impliedProbDown * 100).toFixed(0)}%\n${shortReason}`,
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
  const won = opts.direction === opts.outcome;
  const cost = (opts.entryPrice * opts.size).toFixed(2);
  const payout = won ? opts.size.toFixed(2) : '0.00';
  const pnlSign = opts.pnl >= 0 ? '+' : '';

  const title = won
    ? `WIN | Bought ${opts.direction.toUpperCase()} @ $${opts.entryPrice.toFixed(2)}`
    : `LOSS | Bought ${opts.direction.toUpperCase()} @ $${opts.entryPrice.toFixed(2)}`;

  const lines = [
    `Resolved: **${opts.outcome.toUpperCase()}** | P&L: **${pnlSign}$${opts.pnl.toFixed(2)}**`,
    `Cost: $${cost} | Payout: $${payout}`,
    `Balance: $${opts.balance.toFixed(2)} | Today: ${opts.todayWins}W/${opts.todayLosses}L (${opts.todayPnl >= 0 ? '+' : ''}$${opts.todayPnl.toFixed(2)})`,
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
  const winRate = stats.windowsTraded > 0
    ? ((stats.wins / stats.windowsTraded) * 100).toFixed(0)
    : '0';
  const pnlSign = stats.totalPnl >= 0 ? '+' : '';
  send(
    'DAILY_SUMMARY',
    'Daily Summary',
    `Traded ${stats.windowsTraded} of ${stats.windowsProcessed} windows\n` +
    `Record: **${stats.wins}W / ${stats.losses}L** (${winRate}% win rate)\n` +
    `P&L: **${pnlSign}$${stats.totalPnl.toFixed(2)}** | Balance: $${stats.balance.toFixed(2)}`,
  );
}
