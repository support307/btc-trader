import { logger } from '../clock/logger';
import { btcConfig } from '../config';
import { StrategyDecision, TradeResult, BacktestMetrics } from '../types';

export type BtcNotificationType =
  | 'WINDOW_START'
  | 'TRADE_PLACED'
  | 'TRADE_RESULT'
  | 'WINDOW_RESOLVED'
  | 'DAILY_SUMMARY'
  | 'SYSTEM_STATUS'
  | 'ERROR';

const EMBED_COLORS: Record<BtcNotificationType, number> = {
  WINDOW_START: 0x3498db,   // blue
  TRADE_PLACED: 0x2ecc71,   // green
  TRADE_RESULT: 0xf39c12,   // orange
  WINDOW_RESOLVED: 0x9b59b6, // purple
  DAILY_SUMMARY: 0x1abc9c,  // teal
  SYSTEM_STATUS: 0x95a5a6,  // gray
  ERROR: 0xe74c3c,          // red
};

const MAX_RETRIES = 3;

async function sendWebhook(type: BtcNotificationType, message: string): Promise<void> {
  const webhookUrl = btcConfig.notifications.discordWebhookUrl;
  if (!webhookUrl) return;

  const payload = {
    embeds: [{
      description: message.substring(0, 4096),
      color: EMBED_COLORS[type] || 0x95a5a6,
      footer: { text: `BTC 5-Min Trader | ${type}` },
      timestamp: new Date().toISOString(),
    }],
  };

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

export function btcNotify(type: BtcNotificationType, message: string): void {
  console.log(`[BTC-NOTIFY] ${message}`);
  logger.info(`BTC Notification (${type}): ${message}`);
  sendWebhook(type, message).catch((err) => {
    logger.error(`BTC webhook failed: ${err.message}`);
  });
}

export function notifyDecision(decision: StrategyDecision, windowSlug: string): void {
  if (decision.direction === 'abstain') return;
  btcNotify(
    'TRADE_PLACED',
    `**${decision.direction.toUpperCase()}** on ${windowSlug}\n` +
    `Strategy: ${decision.strategy} | Confidence: ${(decision.confidence * 100).toFixed(1)}%\n` +
    `${decision.reasoning}`
  );
}

export function notifyTradeResult(result: TradeResult): void {
  const emoji = result.pnl > 0 ? '+' : '';
  btcNotify(
    'TRADE_RESULT',
    `**${result.order.direction.toUpperCase()}** ${result.order.windowSlug}\n` +
    `Fill: ${result.fillSize.toFixed(1)} @ $${result.fillPrice.toFixed(3)} | ` +
    `Fee: $${result.fee.toFixed(3)}\n` +
    `P&L: ${emoji}$${result.pnl.toFixed(2)} | Outcome: ${result.resolvedOutcome || 'pending'}`
  );
}

export function notifyDailySummary(stats: {
  windowsProcessed: number;
  windowsTraded: number;
  wins: number;
  losses: number;
  totalPnl: number;
  balance: number;
}): void {
  const winRate = stats.windowsTraded > 0
    ? ((stats.wins / stats.windowsTraded) * 100).toFixed(1)
    : '0';
  btcNotify(
    'DAILY_SUMMARY',
    `**BTC 5-Min Daily Summary**\n` +
    `Windows: ${stats.windowsProcessed} processed, ${stats.windowsTraded} traded\n` +
    `Record: ${stats.wins}W / ${stats.losses}L (${winRate}%)\n` +
    `P&L: $${stats.totalPnl.toFixed(2)} | Balance: $${stats.balance.toFixed(2)}`
  );
}
