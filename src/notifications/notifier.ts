import { logger } from '../utils/logger';
import { config } from '../config';

export type NotificationType =
  | 'SIGNAL_RECEIVED'
  | 'TRADE_OPENED'
  | 'TRADE_UPDATE'
  | 'TRADE_CLOSED'
  | 'EOD_SUMMARY'
  | 'EOD_CLOSE'
  | 'GURU_MESSAGE'
  | 'SAFETY_STOP'
  | 'ERROR';

const EMBED_COLORS: Record<NotificationType, number> = {
  SIGNAL_RECEIVED: 0x3498db, // blue
  TRADE_OPENED: 0x2ecc71,   // green
  TRADE_UPDATE: 0x3498db,   // blue
  TRADE_CLOSED: 0xf39c12,   // orange
  EOD_SUMMARY: 0x9b59b6,    // purple
  EOD_CLOSE: 0xf39c12,      // orange
  GURU_MESSAGE: 0x1abc9c,   // teal
  SAFETY_STOP: 0xe74c3c,    // red
  ERROR: 0xe74c3c,          // red
};

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

async function sendWebhook(type: NotificationType, message: string): Promise<void> {
  const webhookUrl = config.notifications.discordWebhookUrl;
  if (!webhookUrl) return;

  const payload = {
    embeds: [{
      description: message.substring(0, 4096),
      color: EMBED_COLORS[type] || 0x95a5a6,
      footer: { text: `Discord Trader | ${type}` },
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

      if (res.status === 429) {
        const body: any = await res.json().catch(() => ({}));
        const retryAfter = (body.retry_after ?? 2) * 1000;
        logger.warn(`Webhook rate limited, retrying after ${retryAfter}ms`);
        await sleep(retryAfter);
        continue;
      }

      if (res.ok || res.status === 204) return;

      logger.warn(`Webhook attempt ${attempt}/${MAX_RETRIES} failed: ${res.status}`);
    } catch (err: any) {
      logger.warn(`Webhook attempt ${attempt}/${MAX_RETRIES} error: ${err.message}`);
    }

    if (attempt < MAX_RETRIES) {
      await sleep(RETRY_DELAY_MS * attempt);
    }
  }

  logger.error('All webhook retries exhausted');
}

/**
 * Send a notification via Discord webhook (primary) and stdout (fallback).
 * OpenClaw picks up [NOTIFY] lines from stdout. Discord webhook is direct.
 */
export function notify(type: NotificationType, message: string): void {
  const line = `[NOTIFY] ${message}`;
  console.log(line);
  logger.info(`Notification (${type}): ${message}`);

  sendWebhook(type, message).catch((err) => {
    logger.error(`Webhook send failed: ${err.message}`);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
