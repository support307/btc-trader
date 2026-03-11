import winston from 'winston';
import { btcConfig } from '../config';

export const logger = winston.createLogger({
  level: btcConfig.logLevel,
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
      return `[${timestamp}] BTC-TRADER ${level.toUpperCase()}: ${message}${metaStr}`;
    })
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/btc-trader.log', level: 'info' }),
    new winston.transports.File({ filename: 'logs/btc-trader-error.log', level: 'error' }),
  ],
});
