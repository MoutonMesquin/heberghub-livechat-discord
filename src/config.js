// Lecture et validation de la configuration (variables d'environnement).
// Toute valeur invalide arrête le démarrage avec un message explicite.

const SNOWFLAKE = /^\d{17,20}$/;

export class ConfigError extends Error {}

function int(env, name, def, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ConfigError(`${name} doit être un entier entre ${min} et ${max} (reçu « ${raw} »)`);
  }
  return n;
}

function bool(env, name, def) {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  if (/^(1|true|yes|on)$/i.test(raw)) return true;
  if (/^(0|false|no|off)$/i.test(raw)) return false;
  throw new ConfigError(`${name} doit valoir true ou false (reçu « ${raw} »)`);
}

function oneOf(env, name, values, def) {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  if (!values.includes(raw)) throw new ConfigError(`${name} doit valoir ${values.join(', ')} (reçu « ${raw} »)`);
  return raw;
}

export function parseOrigins(raw) {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      let url;
      try {
        url = new URL(s);
      } catch {
        throw new ConfigError(`ALLOWED_ORIGINS : « ${s} » n'est pas une URL valide`);
      }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw new ConfigError(`ALLOWED_ORIGINS : « ${s} » doit commencer par https:// ou http://`);
      }
      return url.origin;
    });
}

/**
 * TRUST_PROXY : nombre de proxys de confiance devant le serveur (0 = aucun),
 * ou liste d'adresses/sous-réseaux (ex. « loopback, 10.0.0.0/8 »).
 * Valeur transmise telle quelle à Express et à proxy-addr.
 */
function trustProxy(env) {
  const raw = (env.TRUST_PROXY ?? '').trim();
  if (raw === '' || /^(0|false|no|off)$/i.test(raw)) return 0;
  if (/^\d+$/.test(raw)) return Number(raw);
  if (/^(true|yes|on)$/i.test(raw)) {
    throw new ConfigError('TRUST_PROXY=true ferait confiance à n\'importe quel X-Forwarded-For : indiquez un nombre de proxys ou une liste d\'adresses');
  }
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function timeZone(env) {
  const tz = env.TIMEZONE || 'Europe/Paris';
  try {
    new Intl.DateTimeFormat('fr-FR', { timeZone: tz });
  } catch {
    throw new ConfigError(`TIMEZONE : fuseau inconnu « ${tz} » (ex. Europe/Paris)`);
  }
  return tz;
}

export function loadConfig(env = process.env, { mock = false } = {}) {
  const port = int(env, 'PORT', 3000, { min: 1, max: 65535 });
  const demoPage = bool(env, 'DEMO_PAGE', mock);

  let allowedOrigins = parseOrigins(env.ALLOWED_ORIGINS);
  if (allowedOrigins.length === 0) {
    if (!mock) throw new ConfigError('ALLOWED_ORIGINS est obligatoire (ex. https://www.example.com,https://example.com)');
    allowedOrigins = [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
  }

  const discord = {
    token: env.DISCORD_TOKEN ?? '',
    guildId: env.DISCORD_GUILD_ID ?? '',
    forumChannelId: env.DISCORD_FORUM_CHANNEL_ID ?? '',
    supportRoleId: env.DISCORD_SUPPORT_ROLE_ID ?? '',
  };
  if (!mock) {
    if (!discord.token) throw new ConfigError('DISCORD_TOKEN est obligatoire');
    for (const [key, name] of [
      ['guildId', 'DISCORD_GUILD_ID'],
      ['forumChannelId', 'DISCORD_FORUM_CHANNEL_ID'],
      ['supportRoleId', 'DISCORD_SUPPORT_ROLE_ID'],
    ]) {
      if (!SNOWFLAKE.test(discord[key])) throw new ConfigError(`${name} doit être un identifiant Discord (17 à 20 chiffres)`);
    }
  }

  const internalPrefix = env.INTERNAL_PREFIX ?? '!';
  if (internalPrefix.length > 5) throw new ConfigError('INTERNAL_PREFIX ne doit pas dépasser 5 caractères');

  return {
    mock,
    port,
    host: env.HOST || '0.0.0.0',
    allowedOrigins,
    trustProxy: trustProxy(env),
    demoPage,
    discord,
    internalPrefix,
    alwaysAvailable: bool(env, 'ALWAYS_AVAILABLE', false),
    visitorIpInDiscord: oneOf(env, 'VISITOR_IP_IN_DISCORD', ['none', 'masked', 'full'], 'none'),
    timeZone: timeZone(env),
    // 2000 au plus : une fois le Markdown échappé, le texte tient dans un embed Discord (4096).
    maxMessageLength: int(env, 'MAX_MESSAGE_LENGTH', 2000, { min: 50, max: 2000 }),
    sessionTtlMs: int(env, 'SESSION_TTL_MINUTES', 30, { min: 1, max: 24 * 60 }) * 60_000,
    disconnectGraceMs: int(env, 'DISCONNECT_GRACE_SECONDS', 120, { min: 0, max: 3600 }) * 1000,
    limits: {
      messagesPerMinute: int(env, 'RATE_MESSAGES_PER_MINUTE', 10, { min: 1, max: 600 }),
      messageBurst: int(env, 'RATE_MESSAGE_BURST', 5, { min: 1, max: 100 }),
      threadsPerIpPerHour: int(env, 'RATE_THREADS_PER_IP_PER_HOUR', 3, { min: 1, max: 1000 }),
      threadsPerHour: int(env, 'RATE_THREADS_GLOBAL_PER_HOUR', 60, { min: 1, max: 10_000 }),
      connectionsPerIp: int(env, 'MAX_CONNECTIONS_PER_IP', 10, { min: 1, max: 1000 }),
    },
    log: {
      level: oneOf(env, 'LOG_LEVEL', ['debug', 'info', 'warn', 'error'], 'info'),
      messages: bool(env, 'LOG_MESSAGES', false),
    },
  };
}
