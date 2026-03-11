import { SignalParser } from './signal-parser';
import { TradeSignal } from './types';
import { logger } from '../utils/logger';
import { config } from '../config';
import { classifyWithLLM, llmClassificationToSignal, ContextMessage } from './llm-classifier';
import * as fs from 'fs';
import * as path from 'path';

export type MessageType =
  | 'GAMEPLAN'
  | 'ENTRY'
  | 'SCALE_IN'
  | 'UPDATE'
  | 'PARTIAL_EXIT'
  | 'FULL_EXIT'
  | 'IRRELEVANT';

export interface ClassifiedMessage {
  type: MessageType;
  raw: string;
  messageId: string;
  timestamp: Date;
  signal?: TradeSignal;
  tickers?: string[];
  direction?: 'call' | 'put';
  mentionedGainPercent?: number;
  classifiedBy?: 'anthropic' | 'grok' | 'regex';
}

const PARTIAL_EXIT_PATTERNS = [
  /sell\s+half/i,
  /take\s+some\s+(off|profits?)/i,
  /take\s+profits?/i,
  /you\s+can\s+sell\s+half/i,
  /lock\s+in\s+(some\s+)?profits?/i,
  /trim\s+(some|half|a\s+little)/i,
  /sell\s+some/i,
  /you\s+guys?\s+know\s+what\s+to\s+do/i,
  /secure\s+(some\s+)?profits?/i,
  /to\s+be\s+safe/i,
];

const FULL_EXIT_PATTERNS = [
  /sell\s+all/i,
  /close\s+(all|everything|out)/i,
  /done\s+for\s+(the\s+)?day/i,
  /get\s+out/i,
  /cut\s+(it|losses|the\s+position)/i,
  /stop\s+loss/i,
  /we'?re?\s+out/i,
  /exit\s+(all|everything|now)/i,
  /cash\s+out/i,
];

const GAMEPLAN_PATTERNS = [
  /game\s*plan/i,
  /today'?s?\s+plan/i,
  /calls?\s+(im|i'?m|i\s+am)\s+watching/i,
  /puts?\s+(im|i'?m|i\s+am)\s+watching/i,
  /watching\s+today/i,
  /the\s+play\s+today/i,
  /here'?s?\s+(?:the\s+)?plan/i,
  /looking\s+at\s+today/i,
];

const SCALE_IN_PATTERNS = [
  /adding\s+here/i,
  /adding\s+more/i,
  /add\s+here/i,
  /better\s+fill/i,
  /final\s+add/i,
  /averaging\s+(down|in)/i,
  /loading\s+(up|more)/i,
  /doubling\s+down/i,
  /adding\s+@everyone/i,
];

const UPDATE_KEYWORDS = [
  /comeback/i,
  /cooking/i,
  /pump/i,
  /dump/i,
  /ripping/i,
  /flying/i,
  /banked/i,
  /amazing/i,
  /incredible/i,
  /beautiful/i,
  /huge/i,
  /insane/i,
  /what\s+a\s+day/i,
  /what\s+a\s+move/i,
  /there'?s?\s+the\s+(big\s+)?(crash|pump|dump|move)/i,
  /caught\s+the\s+bottom/i,
  /we\s+needed?\s+/i,
  /absolutely/i,
  /lets?\s+go/i,
  /high\s+iv/i,
];

const GAIN_PERCENT_PATTERN = /(\d{2,4})\s*%\s*gain/i;
const TICKER_PATTERN = /\$([A-Z]{1,5})/g;

const AUDIT_LOG_PATH = path.join(__dirname, '..', '..', 'logs', 'classifications.jsonl');

let classificationStats = { anthropic: 0, grok: 0, regex: 0 };
let lastClassification: { ts: string; type: string; confidence: number | null; classifiedBy: string } | null = null;

export function getClassificationStats() { return { ...classificationStats }; }
export function getLastClassification() { return lastClassification; }
export function resetClassificationStats() { classificationStats = { anthropic: 0, grok: 0, regex: 0 }; }

function writeAuditLog(entry: {
  messageId: string;
  raw: string;
  type: string;
  confidence: number | null;
  reasoning: string;
  classifiedBy: string;
  imageCount: number;
}): void {
  try {
    const logDir = path.dirname(AUDIT_LOG_PATH);
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

    const record = { ts: new Date().toISOString(), ...entry };
    fs.appendFileSync(AUDIT_LOG_PATH, JSON.stringify(record) + '\n');
  } catch (err: any) {
    logger.warn(`Failed to write classification audit log: ${err.message}`);
  }
}

export class MessageClassifier {
  /**
   * Classify a guru message into an actionable type.
   * Tries Anthropic first, then Grok as failover, then regex.
   * LLMs can understand images, context, and ambiguity that regex cannot.
   */
  static async classify(
    text: string,
    messageId: string,
    imageUrls: string[] = [],
    recentContext: ContextMessage[] = [],
  ): Promise<ClassifiedMessage> {
    const hasLLMKey = config.llm.anthropicApiKey || config.llm.grokApiKey;

    if (config.llm.classifierEnabled && hasLLMKey) {
      try {
        const llmResult = await classifyWithLLM(text, imageUrls, recentContext);
        if (llmResult && llmResult.confidence >= 0.7) {
          const provider = llmResult.provider;
          const signal = llmClassificationToSignal(llmResult, messageId, text);
          const result: ClassifiedMessage = {
            type: llmResult.type as MessageType,
            raw: text,
            messageId,
            timestamp: new Date(),
            signal,
            tickers: llmResult.tickers,
            direction: llmResult.direction ?? undefined,
            mentionedGainPercent: llmResult.mentionedGainPercent ?? undefined,
            classifiedBy: provider,
          };
          logger.info(`[CLASSIFY-${provider.toUpperCase()}] ${result.type} (${(llmResult.confidence * 100).toFixed(0)}%): "${text.substring(0, 60)}"`);

          classificationStats[provider]++;
          lastClassification = {
            ts: new Date().toISOString(),
            type: result.type,
            confidence: llmResult.confidence,
            classifiedBy: provider,
          };
          writeAuditLog({
            messageId,
            raw: text.substring(0, 200),
            type: result.type,
            confidence: llmResult.confidence,
            reasoning: llmResult.reasoning,
            classifiedBy: provider,
            imageCount: imageUrls.length,
          });

          return result;
        }
        if (llmResult) {
          logger.info(`[CLASSIFY] LLM confidence too low (${(llmResult.confidence * 100).toFixed(0)}%), falling back to regex`);
        }
      } catch (err: any) {
        logger.warn(`[CLASSIFY] All LLM providers failed, falling back to regex: ${err.message}`);
      }
    }

    const regexResult = this.classifyWithRegex(text, messageId);

    classificationStats.regex++;
    lastClassification = {
      ts: new Date().toISOString(),
      type: regexResult.type,
      confidence: null,
      classifiedBy: 'regex',
    };
    writeAuditLog({
      messageId,
      raw: text.substring(0, 200),
      type: regexResult.type,
      confidence: null,
      reasoning: 'regex pattern match',
      classifiedBy: 'regex',
      imageCount: imageUrls.length,
    });

    return regexResult;
  }

  /**
   * Regex-based fallback classifier.
   * Priority order matters: exit signals checked before entry signals.
   */
  static classifyWithRegex(text: string, messageId: string): ClassifiedMessage {
    const base: ClassifiedMessage = {
      type: 'IRRELEVANT',
      raw: text,
      messageId,
      timestamp: new Date(),
      classifiedBy: 'regex',
    };

    const tickers = this.extractTickers(text);
    if (tickers.length > 0) base.tickers = tickers;

    const gainMatch = text.match(GAIN_PERCENT_PATTERN);
    if (gainMatch) base.mentionedGainPercent = parseInt(gainMatch[1], 10);

    if (this.matchesAny(text, FULL_EXIT_PATTERNS)) {
      base.type = 'FULL_EXIT';
      logger.info(`[CLASSIFY] FULL_EXIT: "${text.substring(0, 80)}"`);
      return base;
    }

    if (this.matchesAny(text, PARTIAL_EXIT_PATTERNS)) {
      base.type = 'PARTIAL_EXIT';
      logger.info(`[CLASSIFY] PARTIAL_EXIT: "${text.substring(0, 80)}"`);
      return base;
    }

    if (this.matchesAny(text, GAMEPLAN_PATTERNS)) {
      base.type = 'GAMEPLAN';
      base.direction = /put/i.test(text) ? 'put' : /call/i.test(text) ? 'call' : undefined;
      logger.info(`[CLASSIFY] GAMEPLAN: "${text.substring(0, 80)}"`);
      return base;
    }

    const parseResult = SignalParser.parse(text, messageId);
    const hasSignal = parseResult.success && parseResult.signals.length > 0;

    if (hasSignal && this.matchesAny(text, SCALE_IN_PATTERNS)) {
      base.type = 'SCALE_IN';
      base.signal = parseResult.signals[0];
      logger.info(`[CLASSIFY] SCALE_IN: ${base.signal.ticker} ${base.signal.direction} $${base.signal.strikePrice} @ $${base.signal.entryPrice}`);
      return base;
    }

    if (this.matchesAny(text, SCALE_IN_PATTERNS) && !hasSignal) {
      base.type = 'SCALE_IN';
      logger.info(`[CLASSIFY] SCALE_IN (no price): "${text.substring(0, 80)}"`);
      return base;
    }

    if (hasSignal) {
      base.type = 'ENTRY';
      base.signal = parseResult.signals[0];
      logger.info(`[CLASSIFY] ENTRY: ${base.signal.ticker} ${base.signal.direction} $${base.signal.strikePrice} @ $${base.signal.entryPrice}`);
      return base;
    }

    if (this.matchesAny(text, UPDATE_KEYWORDS) || base.mentionedGainPercent) {
      base.type = 'UPDATE';
      logger.info(`[CLASSIFY] UPDATE: "${text.substring(0, 80)}"`);
      return base;
    }

    if (tickers.length > 0 && (/(call|put|\d+[CP])/i.test(text))) {
      base.type = 'UPDATE';
      logger.info(`[CLASSIFY] UPDATE (ticker+options mention): "${text.substring(0, 80)}"`);
      return base;
    }

    logger.debug(`[CLASSIFY] IRRELEVANT: "${text.substring(0, 80)}"`);
    return base;
  }

  private static matchesAny(text: string, patterns: RegExp[]): boolean {
    return patterns.some(p => p.test(text));
  }

  private static extractTickers(text: string): string[] {
    const matches = [...text.matchAll(TICKER_PATTERN)];
    return [...new Set(matches.map(m => m[1]))];
  }
}
