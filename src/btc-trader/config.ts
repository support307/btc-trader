import dotenv from 'dotenv';
dotenv.config();

function env(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

export const btcConfig = {
  get polymarket() {
    return {
      gammaBaseUrl: 'https://gamma-api.polymarket.com',
      clobBaseUrl: 'https://clob.polymarket.com',
      clobWsUrl: 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
      geoblockUrl: 'https://polymarket.com/api/geoblock',
      privateKey: env('POLYMARKET_PRIVATE_KEY', ''),
      chainId: 137,
    };
  },
  get binance() {
    return {
      wsUrl: env('BINANCE_WS_URL', 'wss://stream.binance.com:9443/ws/btcusdt@trade'),
      restUrl: env('BINANCE_REST_URL', 'https://api.binance.com'),
    };
  },
  get alpaca() {
    return {
      apiKey: env('ALPACA_API_KEY', ''),
      apiSecret: env('ALPACA_API_SECRET', ''),
      baseUrl: env('ALPACA_BASE_URL', 'https://paper-api.alpaca.markets'),
    };
  },
  get llm() {
    return {
      anthropicApiKey: env('ANTHROPIC_API_KEY', ''),
      grokApiKey: env('GROK_API_KEY', ''),
    };
  },
  get rssApp() {
    return {
      apiKey: env('RSS_APP_API_KEY', ''),
      apiSecret: env('RSS_APP_API_SECRET', ''),
      baseUrl: 'https://api.rss.app',
    };
  },
  get trading() {
    return {
      windowSeconds: 300,
      strategy: env('BTC_STRATEGY', 'v1') as 'v1' | 'v2',
      budgetPerTrade: Number(env('BTC_BUDGET_PER_TRADE', '2')),
      minConfidence: Number(env('BTC_MIN_CONFIDENCE', '0.60')),
      maxPositionsPerHour: Number(env('BTC_MAX_POSITIONS_PER_HOUR', '12')),
      dryRun: env('BTC_DRY_RUN', 'true') === 'true',
      executionAdapter: env('BTC_EXECUTION_ADAPTER', 'dry-run') as 'dry-run' | 'polymarket' | 'alpaca',
      // V2 proportional sizing: bet 10-50% of bankroll based on Kelly
      maxBetFraction: Number(env('BTC_MAX_BET_FRACTION', '0.50')),
      minBetFraction: Number(env('BTC_MIN_BET_FRACTION', '0.10')),
      minBalance: Number(env('BTC_MIN_BALANCE', '2.50')),
    };
  },
  get notifications() {
    const strategy = env('BTC_STRATEGY', 'v1');
    const v1Url = env(
      'DISCORD_WEBHOOK_URL',
      'https://discord.com/api/webhooks/1480950209105105038/90gLcgW2lzw1Bxohs65fJH9u-fYbbNBngxSXQwcYwZ4IEADHrW0pD0FcwYw-6Q8bgmoM'
    );
    const v2Url = env(
      'BTC_V2_DISCORD_WEBHOOK_URL',
      'https://discord.com/api/webhooks/1481417582719271012/rcALRfSrWj4aKCtEEYiO8R_PuWryLa7c9zMOU_g2jJaE2mk07l0eeTF0oRIgezDqvc7j'
    );
    return {
      discordWebhookUrl: strategy === 'v2' ? v2Url : v1Url,
      strategyLabel: strategy === 'v2' ? 'BTC Trader V2' : 'BTC Trader V1',
    };
  },
  get logLevel() {
    return env('LOG_LEVEL', 'info');
  },
};
