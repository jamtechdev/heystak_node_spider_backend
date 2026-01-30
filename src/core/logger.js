import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '../..');
const logsDir = join(rootDir, 'logs');

// Create logs directory if it doesn't exist
if (!existsSync(logsDir)) {
  mkdirSync(logsDir, { recursive: true });
}

// Custom format
const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    let msg = `${timestamp} - ${level.toUpperCase()} - ${message}`;
    if (Object.keys(meta).length > 0) {
      msg += ` ${JSON.stringify(meta)}`;
    }
    return msg;
  })
);

// Create transports
const transports = [
  // Console transport
  new winston.transports.Console({
    level: 'info',
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.printf(({ timestamp, level, message }) => {
        return `${timestamp} - ${level} - ${message}`;
      })
    ),
  }),
];

// Create logger factory
export function createLogger(name, logFile) {
  const fileTransports = [
    // Main log file
    new DailyRotateFile({
      filename: join(logsDir, `${logFile}-%DATE%.log`),
      datePattern: 'YYYY-MM-DD',
      maxSize: '10m',
      maxFiles: '5d',
      format: logFormat,
    }),
    // Error log file (only errors)
    new DailyRotateFile({
      filename: join(logsDir, 'errors-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxSize: '10m',
      maxFiles: '5d',
      level: 'error',
      format: logFormat,
    }),
  ];

  return winston.createLogger({
    defaultMeta: { service: name },
    level: 'debug',
    format: logFormat,
    transports: [...transports, ...fileTransports],
  });
}

// Create loggers
export const apiLogger = createLogger('api', 'api');
export const workerLogger = createLogger('worker', 'worker');

// Helper function to log exceptions
export function logException(logger, error, context = '') {
  const message = context ? `${context} - ${error.message || String(error)}` : (error.message || String(error));
  logger.error(message, { error: error.stack || error, ...error });
}

export default { apiLogger, workerLogger, createLogger, logException };
