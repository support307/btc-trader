import { config } from '../config';
import { logger } from '../utils/logger';

export class AlpacaError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string
  ) {
    super(message);
    this.name = 'AlpacaError';
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }

  get isTransient(): boolean {
    return this.status >= 500 || this.status === 429;
  }
}

export interface OrderRequest {
  symbol: string;
  qty?: number;
  notional?: number;
  side: 'buy' | 'sell';
  type: 'market' | 'limit' | 'stop' | 'stop_limit';
  time_in_force: 'day' | 'gtc' | 'ioc' | 'fok';
  limit_price?: string;
  stop_price?: string;
}

export interface Position {
  asset_id: string;
  symbol: string;
  qty: string;
  avg_entry_price: string;
  market_value: string;
  unrealized_pl: string;
  unrealized_plpc: string;
  current_price: string;
  side: string;
}

export interface Account {
  id: string;
  account_number: string;
  status: string;
  buying_power: string;
  cash: string;
  portfolio_value: string;
  equity: string;
  last_equity: string;
}

export interface Order {
  id: string;
  client_order_id: string;
  symbol: string;
  qty: string;
  filled_qty: string;
  side: string;
  type: string;
  status: string;
  filled_avg_price: string | null;
  created_at: string;
}

/**
 * Alpaca REST API client for paper trading.
 *
 * Auth: APCA-API-KEY-ID + APCA-API-SECRET-KEY headers.
 * Base URL: https://paper-api.alpaca.markets
 * Trading endpoints: /v2/orders, /v2/positions, /v2/account
 */
export class AlpacaClient {
  private baseUrl: string;
  private headers: Record<string, string>;

  constructor() {
    this.baseUrl = config.alpaca.baseUrl;
    this.headers = {
      'APCA-API-KEY-ID': config.alpaca.apiKey,
      'APCA-API-SECRET-KEY': config.alpaca.apiSecret,
      'Content-Type': 'application/json',
    };
  }

  private async request<T>(method: string, path: string, body?: any): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    logger.debug(`Alpaca ${method} ${path}`);

    const res = await fetch(url, {
      method,
      headers: this.headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new AlpacaError(`Alpaca API error ${res.status}: ${text}`, res.status, text);
    }

    if (res.status === 204) return {} as T;
    return res.json() as Promise<T>;
  }

  // ─── Account ──────────────────────────────────────────

  async getAccount(): Promise<Account> {
    return this.request<Account>('GET', '/v2/account');
  }

  // ─── Orders ───────────────────────────────────────────

  async createOrder(order: OrderRequest): Promise<Order> {
    logger.info(`Creating order: ${order.side} ${order.qty || order.notional} ${order.symbol} (${order.type})`, { order });
    return this.request<Order>('POST', '/v2/orders', order);
  }

  async getOrders(status: 'open' | 'closed' | 'all' = 'open'): Promise<Order[]> {
    return this.request<Order[]>('GET', `/v2/orders?status=${status}&limit=50`);
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.request<void>('DELETE', `/v2/orders/${orderId}`);
  }

  async getOrder(orderId: string): Promise<Order> {
    return this.request<Order>('GET', `/v2/orders/${orderId}`);
  }

  async cancelAllOrders(): Promise<void> {
    await this.request<void>('DELETE', '/v2/orders');
  }

  // ─── Positions ────────────────────────────────────────

  async getPositions(): Promise<Position[]> {
    return this.request<Position[]>('GET', '/v2/positions');
  }

  async getPosition(symbol: string): Promise<Position> {
    return this.request<Position>('GET', `/v2/positions/${symbol}`);
  }

  async closePosition(symbol: string): Promise<Order> {
    logger.info(`Force-closing position: ${symbol} via DELETE /v2/positions`);
    return this.request<Order>('DELETE', `/v2/positions/${symbol}`);
  }
}
