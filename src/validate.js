// Validation de tout ce qui arrive du navigateur : rien n'est supposé fiable.

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CLIENT_ID = /^[A-Za-z0-9_-]{1,40}$/;
// Caractères de contrôle (hors \n et \t), séparateurs invisibles et marques bidi.
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

export function isSessionId(value) {
  return typeof value === 'string' && SESSION_ID.test(value);
}

export function isClientId(value) {
  return typeof value === 'string' && CLIENT_ID.test(value);
}

/**
 * Normalise le texte d'un visiteur.
 * @returns {{ ok: true, text: string } | { ok: false, error: 'invalid' | 'empty' | 'too_long' }}
 */
export function normalizeMessage(value, maxLength) {
  if (typeof value !== 'string') return { ok: false, error: 'invalid' };
  // Coupe tôt pour ne pas traiter de très longues chaînes.
  if (value.length > maxLength * 4) return { ok: false, error: 'too_long' };
  const text = value
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(UNSAFE_CHARS, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
  if (!text) return { ok: false, error: 'empty' };
  if ([...text].length > maxLength) return { ok: false, error: 'too_long' };
  return { ok: true, text };
}

/**
 * Page d'origine du message : uniquement une URL http(s) d'une origine autorisée,
 * sans paramètres ni ancre (ils peuvent contenir des jetons ou des données personnelles).
 */
export function normalizePage(value, allowedOrigins) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!allowedOrigins.includes(url.origin)) return null;
  const page = url.origin + url.pathname;
  return page.length > 300 ? page.slice(0, 299) + '…' : page;
}

/** Résumé grossier du navigateur, suffisant pour le support (« Firefox · Windows »). */
export function summarizeUserAgent(ua) {
  if (typeof ua !== 'string' || !ua) return 'inconnu';
  const browser =
    (/Edg\//.test(ua) && 'Edge') ||
    (/OPR\//.test(ua) && 'Opera') ||
    (/Firefox\//.test(ua) && 'Firefox') ||
    (/Chrome\//.test(ua) && 'Chrome') ||
    (/Safari\//.test(ua) && 'Safari') ||
    'autre navigateur';
  const os =
    (/Android/.test(ua) && 'Android') ||
    (/iPhone|iPad|iPod/.test(ua) && 'iOS') ||
    (/Windows/.test(ua) && 'Windows') ||
    (/Mac OS X/.test(ua) && 'macOS') ||
    (/Linux/.test(ua) && 'Linux') ||
    'autre système';
  return `${browser} · ${os}`;
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Développe une adresse IPv6 en 8 groupes hexadécimaux, ou null si elle est invalide. */
export function expandIPv6(ip) {
  if (typeof ip !== 'string' || !ip.includes(':')) return null;
  let addr = ip.split('%')[0].toLowerCase();
  // Adresse terminée par un IPv4 (ex. ::ffff:1.2.3.4) : conversion en deux groupes.
  const tail = addr.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (tail) {
    const [a, b, c, d] = tail[1].split('.').map(Number);
    addr = addr.slice(0, -tail[1].length) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16);
  }
  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => g.padStart(4, '0'));
}

function ipv4Of(ip) {
  const v4 = ip.replace(/^::ffff:/i, '');
  return IPV4.test(v4) ? v4 : null;
}

/**
 * Clé utilisée par les limites de débit : l'IPv4, ou le préfixe /64 d'une IPv6
 * (un abonné dispose en général d'un /64 entier, qu'il pourrait faire tourner).
 */
export function ipKey(ip) {
  if (!ip) return 'unknown';
  const v4 = ipv4Of(ip);
  if (v4) return v4;
  const groups = expandIPv6(ip);
  return groups ? groups.slice(0, 4).join(':') + '::/64' : ip;
}

/** Masque une adresse IP : IPv4 en /24, IPv6 en /48. */
export function maskIp(ip) {
  if (!ip) return 'inconnue';
  const v4 = ipv4Of(ip);
  if (v4) return v4.replace(/\.\d+$/, '.x');
  const groups = expandIPv6(ip);
  return groups ? groups.slice(0, 3).join(':') + '::/48' : 'inconnue';
}
