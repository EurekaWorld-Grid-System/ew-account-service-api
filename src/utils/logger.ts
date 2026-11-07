import winston from 'winston';
import { config, SERVICE_NAME } from '../config';

const pretty = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    const rest = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `${timestamp} ${level} ${message}${rest}`;
  })
);

const json = winston.format.combine(winston.format.timestamp(), winston.format.errors({ stack: true }), winston.format.json());

export const logger = winston.createLogger({
  level: config.logLevel,
  defaultMeta: config.logFormat === 'json' ? { service: SERVICE_NAME } : undefined,
  format: config.logFormat === 'json' ? json : pretty,
  transports: [new winston.transports.Console()],
});
