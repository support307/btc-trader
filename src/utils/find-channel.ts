/**
 * Helper script to list all guilds and text channels visible to the user token.
 * Usage: npx tsx src/utils/find-channel.ts
 */
import dotenv from 'dotenv';
dotenv.config();

const TOKEN = process.env.DISCORD_USER_TOKEN;
if (!TOKEN) {
  console.error('Missing DISCORD_USER_TOKEN in .env');
  process.exit(1);
}

const API = 'https://discord.com/api/v10';

interface Guild {
  id: string;
  name: string;
}

interface Channel {
  id: string;
  name: string;
  type: number; // 0 = text, 2 = voice, 4 = category, etc.
  parent_id?: string;
}

async function apiFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: TOKEN! },
  });
  if (res.status === 429) {
    const body: any = await res.json().catch(() => ({}));
    const wait = (body.retry_after ?? 5) * 1000;
    console.log(`Rate limited, waiting ${wait / 1000}s...`);
    await new Promise((r) => setTimeout(r, wait));
    return apiFetch(path);
  }
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

async function main() {
  const guilds = await apiFetch<Guild[]>('/users/@me/guilds');
  console.log(`\nFound ${guilds.length} guild(s):\n`);

  for (const guild of guilds) {
    console.log(`📂 ${guild.name} (${guild.id})`);
    try {
      const channels = await apiFetch<Channel[]>(`/guilds/${guild.id}/channels`);
      const textChannels = channels
        .filter((c) => c.type === 0)
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const ch of textChannels) {
        console.log(`   #${ch.name} → ${ch.id}`);
      }
    } catch (err: any) {
      console.log(`   (could not fetch channels: ${err.message})`);
    }
    console.log();
  }
}

main().catch(console.error);
