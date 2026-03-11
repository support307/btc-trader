import { TradeSignal, ParseResult } from './types';
import { logger } from '../utils/logger';

/**
 * Parses Discord messages for trading signals.
 *
 * Supported formats:
 *   "2/11 $IWM Put at $265 at 0.12"
 *   "$SPY Call 580 @ 1.25"
 *   "$TSLA 250P at 0.45"
 *   "Buy $QQQ 490C for 0.80"
 */
export class SignalParser {
  /**
   * Main pattern: $TICKER (Call|Put|C|P) [at|@] $STRIKE [at|@|for] PRICE
   * Handles many natural orderings.
   */
  private static readonly PATTERNS = [
    // "$IWM Put at $265 at 0.12" or "$IWM Call $265 @ 0.12"
    /\$([A-Z]{1,5})\s+(call|put)\s+(?:at\s+)?\$?(\d+(?:\.\d+)?)\s+(?:at|@|for)\s+\$?(\d+(?:\.\d+)?)/i,
    // "$IWM 265P at 0.12" or "$IWM 265C @ 0.12"
    /\$([A-Z]{1,5})\s+\$?(\d+(?:\.\d+)?)(C|P)\s+(?:at|@|for)\s+\$?(\d+(?:\.\d+)?)/i,
    // "Buy $IWM 265P 0.12"
    /(?:buy|sell)\s+\$([A-Z]{1,5})\s+\$?(\d+(?:\.\d+)?)(C|P)\s+(?:at|@|for)?\s*\$?(\d+(?:\.\d+)?)/i,
    // "$IWM Put $265 0.12" (no separator between strike and price)
    /\$([A-Z]{1,5})\s+(call|put)\s+\$?(\d+(?:\.\d+)?)\s+\$?(\d+(?:\.\d+)?)/i,
  ];

  /** Extract date prefix like "2/11" */
  private static readonly DATE_PATTERN = /(\d{1,2}\/\d{1,2})/;

  /** Extract stop loss mentions */
  private static readonly STOP_PATTERN = /(?:stop|sl|stop.?loss)\s*(?:at|@|:)?\s*\$?(\d+(?:\.\d+)?)/i;

  /** Extract target/TP mentions */
  private static readonly TARGET_PATTERN = /(?:target|tp|take.?profit)\s*(?:at|@|:)?\s*\$?(\d+(?:\.\d+)?)/i;

  static parse(text: string, messageId: string): ParseResult {
    const signals: TradeSignal[] = [];
    const errors: string[] = [];

    // Try each pattern
    for (const pattern of this.PATTERNS) {
      const matches = text.matchAll(new RegExp(pattern, 'gi'));
      for (const match of matches) {
        try {
          const signal = this.matchToSignal(match, pattern, text, messageId);
          if (signal) {
            // Check for duplicates (same ticker+direction)
            const isDupe = signals.some(
              (s) => s.ticker === signal.ticker && s.direction === signal.direction && s.strikePrice === signal.strikePrice
            );
            if (!isDupe) signals.push(signal);
          }
        } catch (e: any) {
          errors.push(`Parse error: ${e.message}`);
        }
      }
      if (signals.length > 0) break; // Use first matching pattern
    }

    if (signals.length === 0 && this.looksLikeSignal(text)) {
      errors.push(`Message looks like a signal but could not be parsed: "${text.substring(0, 100)}"`);
    }

    if (signals.length > 0) {
      logger.info(`Parsed ${signals.length} signal(s) from message ${messageId}`, {
        signals: signals.map((s) => `${s.ticker} ${s.direction} $${s.strikePrice} @ ${s.entryPrice}`),
      });
    }

    return { success: signals.length > 0, signals, errors };
  }

  private static matchToSignal(
    match: RegExpMatchArray,
    pattern: RegExp,
    fullText: string,
    messageId: string
  ): TradeSignal | null {
    const patternIndex = this.PATTERNS.indexOf(pattern);

    let ticker: string;
    let direction: 'call' | 'put';
    let strikePrice: number;
    let entryPrice: number;

    if (patternIndex === 0 || patternIndex === 3) {
      // $TICKER direction strike price
      ticker = match[1].toUpperCase();
      direction = match[2].toLowerCase() === 'call' ? 'call' : 'put';
      strikePrice = parseFloat(match[3]);
      entryPrice = parseFloat(match[4]);
    } else if (patternIndex === 1) {
      // $TICKER strikeC/P price
      ticker = match[1].toUpperCase();
      strikePrice = parseFloat(match[2]);
      direction = match[3].toUpperCase() === 'C' ? 'call' : 'put';
      entryPrice = parseFloat(match[4]);
    } else if (patternIndex === 2) {
      // Buy/Sell $TICKER strikeC/P price
      ticker = match[1].toUpperCase();
      strikePrice = parseFloat(match[2]);
      direction = match[3].toUpperCase() === 'C' ? 'call' : 'put';
      entryPrice = parseFloat(match[4]);
    } else {
      return null;
    }

    if (isNaN(strikePrice) || isNaN(entryPrice)) return null;

    // Extract optional fields
    const stopMatch = fullText.match(this.STOP_PATTERN);
    const targetMatch = fullText.match(this.TARGET_PATTERN);
    const dateMatch = fullText.match(this.DATE_PATTERN);

    return {
      raw: fullText,
      ticker,
      direction,
      strikePrice,
      entryPrice,
      expiration: dateMatch?.[1],
      stopLoss: stopMatch ? parseFloat(stopMatch[1]) : undefined,
      target: targetMatch ? parseFloat(targetMatch[1]) : undefined,
      timestamp: new Date(),
      messageId,
    };
  }

  /** Heuristic: does this message look like it might contain a signal? */
  private static looksLikeSignal(text: string): boolean {
    return /\$[A-Z]{1,5}/i.test(text) && /(call|put|\d+[CP])/i.test(text);
  }
}
