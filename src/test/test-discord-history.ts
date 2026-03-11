/**
 * Test script: Pull real Discord messages from the guru channel and classify them with LLM.
 * Fetches messages from multiple days to verify AI interpretation works on real data.
 *
 * Usage: npx tsx src/test/test-discord-history.ts
 */

import { config } from '../config';
import { classifyWithLLM, ContextMessage } from '../parser/llm-classifier';
import { MessageClassifier } from '../parser/message-classifier';

const DISCORD_API = 'https://discord.com/api/v10';
const GURU_NAME = config.discord.authorName;

interface DiscordMessage {
  id: string;
  content: string;
  author: { username: string; global_name?: string };
  member?: { nick?: string };
  timestamp: string;
  attachments?: Array<{ url: string; content_type?: string; width?: number; height?: number }>;
}

async function fetchMessages(beforeId?: string, limit = 50): Promise<DiscordMessage[]> {
  const { channelId, userToken } = config.discord;
  const params = new URLSearchParams({ limit: String(limit) });
  if (beforeId) params.set('before', beforeId);

  const url = `${DISCORD_API}/channels/${channelId}/messages?${params}`;
  const res = await fetch(url, {
    headers: { Authorization: userToken },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Discord API ${res.status}: ${text}`);
  }

  return res.json() as Promise<DiscordMessage[]>;
}

function isGuru(msg: DiscordMessage): boolean {
  const name = msg.member?.nick || msg.author.global_name || msg.author.username;
  return name.toLowerCase().includes(GURU_NAME.toLowerCase());
}

function formatTime(ts: string): string {
  const d = new Date(ts);
  return d.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
}

function getDateKey(ts: string): string {
  const d = new Date(ts);
  return d.toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' });
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  Discord History Classification Test (Real Messages)    ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  console.log(`Channel: ${config.discord.channelId}`);
  console.log(`Guru: ${GURU_NAME}`);
  console.log(`Anthropic key: ${config.llm.anthropicApiKey ? 'SET' : 'MISSING'}`);
  console.log(`Grok key: ${config.llm.grokApiKey ? 'SET' : 'MISSING'}\n`);

  console.log('Fetching messages from Discord...\n');

  const allGuruMessages: DiscordMessage[] = [];
  let beforeId: string | undefined;

  for (let batch = 0; batch < 6; batch++) {
    const messages = await fetchMessages(beforeId, 100);
    if (messages.length === 0) break;

    const guruMsgs = messages.filter(isGuru);
    allGuruMessages.push(...guruMsgs);
    beforeId = messages[messages.length - 1].id;

    console.log(`  Batch ${batch + 1}: ${messages.length} messages, ${guruMsgs.length} from guru`);
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`\nTotal guru messages found: ${allGuruMessages.length}\n`);

  const byDate = new Map<string, DiscordMessage[]>();
  for (const msg of allGuruMessages) {
    const key = getDateKey(msg.timestamp);
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key)!.push(msg);
  }

  const sortedDates = [...byDate.keys()].sort();
  let totalClassified = 0;
  let anthropicCount = 0;
  let grokCount = 0;
  let regexCount = 0;

  for (const date of sortedDates) {
    const msgs = byDate.get(date)!.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  ${date} — ${msgs.length} guru message(s)`);
    console.log(`${'═'.repeat(60)}\n`);

    const recentContext: ContextMessage[] = [];

    for (const msg of msgs) {
      const text = msg.content || '';
      const imageUrls = (msg.attachments || [])
        .filter(a => a.content_type?.startsWith('image/'))
        .map(a => a.url);

      const hasImages = imageUrls.length > 0;
      const preview = text.substring(0, 80).replace(/\n/g, ' ') || '(image only)';
      const time = formatTime(msg.timestamp);

      const classified = await MessageClassifier.classify(text, msg.id, imageUrls, recentContext);
      totalClassified++;

      const provider = classified.classifiedBy || 'unknown';
      if (provider === 'anthropic') anthropicCount++;
      else if (provider === 'grok') grokCount++;
      else regexCount++;

      const signalStr = classified.signal
        ? ` → ${classified.signal.ticker} ${classified.signal.direction} $${classified.signal.strikePrice} @ $${classified.signal.entryPrice}`
        : '';
      const imgTag = hasImages ? ' [IMG]' : '';

      const color = provider === 'anthropic' ? '\x1b[36m' : provider === 'grok' ? '\x1b[33m' : '\x1b[90m';
      const reset = '\x1b[0m';

      console.log(`  ${time}  ${color}[${provider}]${reset}  ${classified.type}${signalStr}${imgTag}`);
      console.log(`    "${preview}"\n`);

      recentContext.push({
        text: text || '(image only)',
        timestamp: msg.timestamp,
        classification: classified.type,
      });
      if (recentContext.length > 10) recentContext.shift();

      await new Promise(r => setTimeout(r, 300));
    }
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log('  SUMMARY');
  console.log(`${'═'.repeat(60)}\n`);
  console.log(`  Total guru messages classified: ${totalClassified}`);
  console.log(`  Anthropic (Claude): ${anthropicCount}`);
  console.log(`  Grok (xAI):         ${grokCount}`);
  console.log(`  Regex fallback:     ${regexCount}`);
  console.log(`  LLM success rate:   ${(((anthropicCount + grokCount) / totalClassified) * 100).toFixed(1)}%\n`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
