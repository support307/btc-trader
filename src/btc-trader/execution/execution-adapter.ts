import { TradeOrder, TradeResult, Direction } from '../types';

export interface ExecutionAdapter {
  readonly name: string;

  isAvailable(): Promise<boolean>;

  placeOrder(order: TradeOrder): Promise<TradeResult>;

  cancelOrder(orderId: string): Promise<boolean>;

  getBalance(): Promise<{ available: number; currency: string }>;

  getOpenPositions(): Promise<Array<{
    tokenId: string;
    side: string;
    size: number;
    avgPrice: number;
  }>>;
}

export function createOrderId(strategy: string, windowSlug: string): string {
  return `${strategy}-${windowSlug}-${Date.now()}`;
}
