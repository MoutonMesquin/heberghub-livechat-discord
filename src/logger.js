// Journalisation JSON sur la sortie standard (rotation laissée à Docker / systemd).
// Les adresses IP ne sont jamais journalisées en clair : seulement une empreinte
// courte, salée au démarrage du processus, qui permet de corréler sans identifier.

import { createHash, randomBytes } from 'node:crypto';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const SALT = randomBytes(16);

export function ipTag(ip) {
  if (!ip) return 'unknown';
  return createHash('sha256').update(SALT).update(ip).digest('hex').slice(0, 10);
}

export function createLogger({ level = 'info', stream = process.stdout } = {}) {
  const min = LEVELS[level] ?? LEVELS.info;
  const write = (lvl, msg, fields) => {
    if (LEVELS[lvl] < min) return;
    const entry = { time: new Date().toISOString(), level: lvl, msg, ...fields };
    if (entry.err instanceof Error) {
      entry.err = { message: entry.err.message, code: entry.err.code, stack: lvl === 'error' ? entry.err.stack : undefined };
    }
    stream.write(JSON.stringify(entry) + '\n');
  };
  return {
    debug: (msg, fields) => write('debug', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
  };
}

export const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
