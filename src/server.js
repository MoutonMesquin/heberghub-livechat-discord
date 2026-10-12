// Point d'entrée : `node src/server.js` (ou `--mock` pour simuler Discord en local).

import { createApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { createLogger } from './logger.js';

const mock = process.argv.includes('--mock') || /^(1|true)$/i.test(process.env.DISCORD_MOCK ?? '');

let config;
try {
  config = loadConfig(process.env, { mock });
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  console.error(`Configuration invalide : ${err.message}`);
  process.exit(1);
}

const logger = createLogger({ level: config.log.level });

let discord;
if (mock) {
  const { MockDiscordAdapter } = await import('./discord/mock.js');
  discord = new MockDiscordAdapter({ logger });
} else {
  const { DiscordAdapter } = await import('./discord/client.js');
  discord = new DiscordAdapter({ config, logger });
}

const app = createApp({ config, discord, logger });

discord.on('fatal', () => shutdown('discord_fatal', 1));

const address = await app.listen();
logger.info('server_started', { port: address.port, origins: config.allowedOrigins, mock });

discord.start().catch((err) => {
  logger.error('discord_login_failed', { err });
  shutdown('discord_login_failed', 1);
});

let stopping = false;
async function shutdown(reason, code = 0) {
  if (stopping) return;
  stopping = true;
  logger.info('server_stopping', { reason });
  const force = setTimeout(() => process.exit(code || 1), 10_000);
  force.unref();
  try {
    await app.close();
    await discord.stop();
  } catch (err) {
    logger.error('shutdown_error', { err });
  }
  process.exit(code);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => logger.error('unhandled_rejection', { err: reason instanceof Error ? reason : new Error(String(reason)) }));
process.on('uncaughtException', (err) => {
  logger.error('uncaught_exception', { err });
  shutdown('uncaught_exception', 1);
});
