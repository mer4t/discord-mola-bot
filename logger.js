'use strict';

const path = require('path');
const winston = require('winston');
require('winston-daily-rotate-file');
const { CONFIG } = require('./config');

const LOG_DIR = path.join(__dirname, 'logs');

const timezoned = () => {
  const now = new Date();
  return now.toLocaleString('sv-SE', { timeZone: CONFIG.timezone }).replace(' ', 'T');
};

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: timezoned }),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} [${level.toUpperCase()}] ${message}`;
    })
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp({ format: timezoned }),
        winston.format.printf(({ timestamp, level, message }) => {
          return `${timestamp} ${level}: ${message}`;
        })
      )
    }),
    new winston.transports.DailyRotateFile({
      dirname: LOG_DIR,
      filename: 'bot-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '30d'
    })
  ]
});

module.exports = { logger };
