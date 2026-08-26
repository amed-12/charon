import TelegramBot from 'node-telegram-bot-api';
import { TELEGRAM_BOT_TOKEN, TELEGRAM_ENABLED } from '../config.js';

function stubBot(reason) {
  console.log(`[telegram] disabled: ${reason}`);
  const noop = async (...args) => {
    if (args.length) console.log(`[telegram] skipped send: ${reason}`);
    return { message_id: 0 };
  };
  return new Proxy({}, {
    get(_target, prop) {
      if (prop === 'on' || prop === 'once' || prop === 'removeListener') return () => {};
      if (prop === 'isTelegramDisabled') return true;
      if (prop === 'isPollingEnabled') return false;
      return noop;
    },
  });
}

function createBot() {
  if (!TELEGRAM_ENABLED) return stubBot('TELEGRAM_ENABLED=false');
  if (!TELEGRAM_BOT_TOKEN) return stubBot('token missing');

  const telegramBot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
  telegramBot.isTelegramDisabled = false;
  telegramBot.isPollingEnabled = true;
  telegramBot.getMe()
    .then(() => console.log('[telegram] polling enabled'))
    .catch(err => console.log(`[telegram] authentication failed: ${err.message}`));
  return telegramBot;
}

export const bot = createBot();
