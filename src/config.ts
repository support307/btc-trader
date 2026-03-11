import dotenv from 'dotenv';
dotenv.config();

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function env(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

/** Lazy config — values read on first access so env vars can be set before import */
export const config = {
  get discord() {
    return {
      userToken: required('DISCORD_USER_TOKEN'),
      channelId: required('DISCORD_CHANNEL_ID'),
      authorName: env('DISCORD_AUTHOR_NAME', 'Stocksandrealestate'),
      pollIntervalMs: Number(env('DISCORD_POLL_INTERVAL_MS', '3000')),
    };
  },
  get alpaca() {
    return {
      apiKey: required('ALPACA_API_KEY'),
      apiSecret: required('ALPACA_API_SECRET'),
      baseUrl: env('ALPACA_BASE_URL', 'https://paper-api.alpaca.markets'),
      dataUrl: env('ALPACA_DATA_URL', 'https://data.alpaca.markets'),
    };
  },
  get trading() {
    return {
      budgetPercent: Number(env('BUDGET_PERCENT', '25')),
      maxConcurrentPositions: Number(env('MAX_CONCURRENT_POSITIONS', '3')),
    };
  },
  get notifications() {
    return {
      discordWebhookUrl: env('DISCORD_WEBHOOK_URL', ''),
    };
  },
  get llm() {
    return {
      anthropicApiKey: env('ANTHROPIC_API_KEY', ''),
      grokApiKey: env('GROK_API_KEY', ''),
      classifierEnabled: env('LLM_CLASSIFIER_ENABLED', 'true') === 'true',
      classifierTimeoutMs: Number(env('LLM_CLASSIFIER_TIMEOUT_MS', '5000')),
    };
  },
  get logLevel() {
    return env('LOG_LEVEL', 'info');
  },
};
