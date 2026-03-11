import { config } from '../config';
import { logger } from '../utils/logger';
import { MessageClassifier, ClassifiedMessage } from '../parser/message-classifier';
import { GuruTradeManager } from '../trading/guru-trade-manager';
import * as notifier from '../notifications/notifier';
import { ContextMessage } from '../parser/llm-classifier';

const DISCORD_API = 'https://discord.com/api/v10';

const HOT_ZONE_POLL_MS = 3000;
const CRUISE_ZONE_POLL_MS = 10000;
const OFF_HOURS_POLL_MS = 60000;

const HEALTH_ALERT_THRESHOLD = 5;
const HOT_ZONE_SILENCE_ALERT_MS = 30 * 60_000;
const CONTEXT_WINDOW_SIZE = 10;

interface DiscordMessage {
  id: string;
  content: string;
  author: {
    id: string;
    username: string;
    global_name?: string;
  };
  member?: {
    nick?: string;
  };
  timestamp: string;
  embeds?: Array<{
    title?: string;
    description?: string;
    fields?: Array<{ name: string; value: string }>;
  }>;
  attachments?: Array<{
    id: string;
    filename: string;
    url: string;
    proxy_url: string;
    content_type?: string;
    width?: number;
    height?: number;
  }>;
}

type PollZone = 'hot' | 'cruise' | 'off';

/**
 * Polls a Discord channel with adaptive intervals.
 * Hot zone (6:25-7:45 AM PST): every 3s — entries and first profit signals
 * Cruise zone (7:45 AM-12:40 PM PST): every 10s — late exits and updates
 * Off hours: every 60s — just watching
 */
export class DiscordMonitor {
  private tradeManager: GuruTradeManager;
  private lastMessageId: string | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private currentZone: PollZone = 'off';
  private onMessage?: (classified: ClassifiedMessage) => void;

  private consecutivePollErrors = 0;
  private lastSuccessfulPoll = Date.now();
  private lastGuruMessageTime = 0;
  private healthAlertSent = false;
  private silenceAlertSent = false;

  private recentMessages: ContextMessage[] = [];

  constructor(tradeManager: GuruTradeManager, onMessage?: (classified: ClassifiedMessage) => void) {
    this.tradeManager = tradeManager;
    this.onMessage = onMessage;
  }

  async start(): Promise<void> {
    const { channelId, authorName } = config.discord;
    logger.info(`Discord monitor starting — channel: ${channelId}, author: ${authorName}`);

    await this.seedLastMessageId();

    this.running = true;
    this.schedulePoll();
    logger.info('Discord monitor running with adaptive polling');
  }

  private async seedLastMessageId(): Promise<void> {
    try {
      const messages = await this.fetchMessages(1);
      if (messages.length > 0) {
        this.lastMessageId = messages[0].id;
        logger.info(`Seeded last message ID: ${this.lastMessageId}`);
      }
    } catch (err: any) {
      logger.warn(`Could not seed last message ID: ${err.message}`);
    }
  }

  private getZone(): PollZone {
    const now = new Date();
    const pst = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
    const day = pst.getDay();
    const hour = pst.getHours();
    const min = pst.getMinutes();
    const totalMin = hour * 60 + min;

    if (day === 0 || day === 6) return 'off';

    // Hot zone: 6:25 AM - 7:45 AM PST (entries + first profit signals)
    if (totalMin >= 385 && totalMin < 465) return 'hot';

    // Cruise zone: 7:45 AM - 12:40 PM PST (late exits + updates)
    if (totalMin >= 465 && totalMin < 750) return 'cruise';

    return 'off';
  }

  private getPollInterval(): number {
    const zone = this.getZone();
    if (zone !== this.currentZone) {
      this.currentZone = zone;
      logger.info(`Poll zone changed to: ${zone}`);
    }

    switch (zone) {
      case 'hot': return HOT_ZONE_POLL_MS;
      case 'cruise': return CRUISE_ZONE_POLL_MS;
      case 'off': return OFF_HOURS_POLL_MS;
    }
  }

  private schedulePoll(): void {
    if (!this.running) return;
    const interval = this.getPollInterval();
    this.pollTimer = setTimeout(async () => {
      await this.poll();
      this.schedulePoll();
    }, interval);
  }

  private async poll(): Promise<void> {
    try {
      const messages = await this.fetchMessages(10);

      this.consecutivePollErrors = 0;
      this.lastSuccessfulPoll = Date.now();
      if (this.healthAlertSent) {
        notifier.notify('SIGNAL_RECEIVED', 'Discord polling RECOVERED — connection restored.');
        this.healthAlertSent = false;
      }

      if (messages.length === 0) {
        this.checkHotZoneSilence();
        return;
      }

      const newMessages = this.lastMessageId
        ? messages.filter((m) => BigInt(m.id) > BigInt(this.lastMessageId!)).reverse()
        : messages.reverse();

      if (newMessages.length === 0) {
        this.checkHotZoneSilence();
        return;
      }

      this.lastMessageId = newMessages[newMessages.length - 1].id;

      for (const msg of newMessages) {
        await this.processMessage(msg);
      }
    } catch (err: any) {
      this.consecutivePollErrors++;
      logger.error(`Poll error (${this.consecutivePollErrors}): ${err.message}`);

      if (this.consecutivePollErrors >= HEALTH_ALERT_THRESHOLD && !this.healthAlertSent) {
        this.healthAlertSent = true;
        notifier.notify('ERROR',
          `Discord polling FAILING: ${this.consecutivePollErrors} consecutive errors. Last: ${err.message}. Check Discord token and connection.`
        );
      }
    }
  }

  private checkHotZoneSilence(): void {
    const zone = this.getZone();
    if (zone !== 'hot') {
      this.silenceAlertSent = false;
      return;
    }

    if (this.lastGuruMessageTime === 0) return;

    const silenceDuration = Date.now() - this.lastGuruMessageTime;
    if (silenceDuration >= HOT_ZONE_SILENCE_ALERT_MS && !this.silenceAlertSent) {
      this.silenceAlertSent = true;
      const mins = Math.round(silenceDuration / 60_000);
      notifier.notify('TRADE_UPDATE',
        `No guru messages for ${mins} minutes during hot zone. Discord may be disconnected, or guru is quiet.`
      );
    }
  }

  private async fetchMessages(limit: number): Promise<DiscordMessage[]> {
    const { channelId, userToken } = config.discord;
    const params = new URLSearchParams({ limit: String(limit) });
    if (this.lastMessageId) {
      params.set('after', this.lastMessageId);
    }

    const url = `${DISCORD_API}/channels/${channelId}/messages?${params}`;
    const res = await fetch(url, {
      headers: { Authorization: userToken },
    });

    if (res.status === 429) {
      const body: any = await res.json().catch(() => ({}));
      const retryAfter = body.retry_after ?? 5;
      logger.warn(`Rate limited — retrying after ${retryAfter}s`);
      await sleep(retryAfter * 1000);
      return this.fetchMessages(limit);
    }

    if (!res.ok) {
      throw new Error(`Discord API ${res.status}: ${await res.text()}`);
    }

    return res.json() as Promise<DiscordMessage[]>;
  }

  private async processMessage(msg: DiscordMessage): Promise<void> {
    const authorName = config.discord.authorName;
    const displayName =
      msg.member?.nick || msg.author.global_name || msg.author.username;

    if (authorName && !displayName.toLowerCase().includes(authorName.toLowerCase())) {
      return;
    }

    this.lastGuruMessageTime = Date.now();
    this.silenceAlertSent = false;

    let content = msg.content;
    if (!content && msg.embeds?.length) {
      content = msg.embeds.map(e => [e.title, e.description].filter(Boolean).join(' ')).join(' ');
    }

    const imageUrls = (msg.attachments || [])
      .filter(a => a.content_type?.startsWith('image/') || /\.(png|jpg|jpeg|gif|webp)$/i.test(a.filename))
      .map(a => a.url);

    if (!content && imageUrls.length === 0) return;

    const logContent = content || `(${imageUrls.length} image(s), no text)`;
    logger.info(`[DISCORD] ${displayName}: "${logContent.substring(0, 120)}${logContent.length > 120 ? '...' : ''}"${imageUrls.length > 0 ? ` [${imageUrls.length} image(s)]` : ''}`);

    const classified = await MessageClassifier.classify(
      content || '', msg.id, imageUrls, this.recentMessages,
    );

    this.recentMessages.push({
      text: content || '(image only)',
      timestamp: msg.timestamp,
      classification: classified.type,
    });
    if (this.recentMessages.length > CONTEXT_WINDOW_SIZE) {
      this.recentMessages.shift();
    }

    if (this.onMessage) {
      this.onMessage(classified);
    }

    if (classified.type !== 'IRRELEVANT') {
      await this.tradeManager.handleMessage(classified);
    }
  }

  async stop(): Promise<void> {
    logger.info('Shutting down Discord monitor...');
    this.running = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
