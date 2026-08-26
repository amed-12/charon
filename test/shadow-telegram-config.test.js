import assert from 'node:assert/strict';

import { SHADOW_MODE, TELEGRAM_ENABLED, validateConfig } from '../src/config.js';
import { initDb } from '../src/db/connection.js';
import { setSetting } from '../src/db/settings.js';
import { tradingMode } from '../src/db/positions.js';
import { initLiveExecution, liveWalletPubkey, requireLiveExecution } from '../src/liveExecutor.js';
import { bot } from '../src/telegram/bot.js';

assert.equal(SHADOW_MODE, true);
assert.equal(TELEGRAM_ENABLED, true);
assert.doesNotThrow(() => validateConfig());
assert.equal(bot.isTelegramDisabled, true);
assert.equal(bot.isPollingEnabled, false);

initDb();
setSetting('trading_mode', 'live');
assert.equal(tradingMode(), 'dry_run', 'SHADOW_MODE must override a live database setting');

initLiveExecution();
assert.equal(liveWalletPubkey(), null);
assert.throws(() => requireLiveExecution(), /disabled by SHADOW_MODE/);

console.log('=== Charon shadow Telegram config tests complete ===');
