import TelegramBot from 'node-telegram-bot-api';
import { TELEGRAM_BOT_TOKEN, TELEGRAM_ENABLED } from '../config.js';

// Without a token there is nothing to poll. Constructing a real TelegramBot here
// would start a polling loop that 401s forever, so dry_run and headless test runs
// get a stub that logs instead of sending. Every method returns a resolved promise
// so callers keep working unchanged.
function stubBot() {
  const noop = async (...args) => {
    console.log('[telegram] disabled (no TELEGRAM_BOT_TOKEN):', args[1] ?? args[0] ?? '');
    return { message_id: 0 };
  };
  return new Proxy({}, {
    get(_target, prop) {
      if (prop === 'on' || prop === 'once' || prop === 'removeListener') return () => {};
      if (prop === 'isTelegramDisabled') return true;
      return noop;
    },
  });
}

export const bot = TELEGRAM_ENABLED && TELEGRAM_BOT_TOKEN
  ? new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true })
  : stubBot();
