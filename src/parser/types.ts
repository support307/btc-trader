/** A parsed trading signal from a Discord message */
export interface TradeSignal {
  /** Raw message text */
  raw: string;
  /** Ticker symbol without $ prefix */
  ticker: string;
  /** Call or Put */
  direction: 'call' | 'put';
  /** Strike price (e.g., 265) */
  strikePrice: number;
  /** Entry/premium price (e.g., 0.12) */
  entryPrice: number;
  /** Optional expiration date */
  expiration?: string;
  /** Optional stop-loss price */
  stopLoss?: number;
  /** Optional profit target */
  target?: number;
  /** Timestamp when signal was received */
  timestamp: Date;
  /** Discord message ID for deduplication */
  messageId: string;
}

/** Result of parsing attempt */
export interface ParseResult {
  success: boolean;
  signals: TradeSignal[];
  errors: string[];
}
