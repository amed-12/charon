import { setDefaultResultOrder } from 'node:dns';
import TelegramBot from 'node-telegram-bot-api';
import { TELEGRAM_BOT_TOKEN } from '../config.js';

setDefaultResultOrder('ipv4first');

export const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, {
  polling: {
    interval: 1000,
    autoStart: true,
    params: { timeout: 20 },
  },
  request: {
    timeout: 65_000,
    agentOptions: { family: 4 },
  },
});
