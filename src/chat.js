// Cœur du chat : relie les sockets des visiteurs aux fils Discord.
//
// Protocole (Socket.IO) :
//   client → serveur  handshake auth { sessionId? }
//                     message { text, page?, clientId? }  + ack → { ok, id, at } | { ok: false, error }
//   serveur → client  session { sessionId, maxLength }
//                     status  { available }
//                     message { id, text, at }   réponse de l'équipe
//                     echo    { id, text, at }   message envoyé depuis un autre onglet de la même session
//                     typing  {}
//                     closed  {}                 conversation close par l'équipe

import proxyaddr from 'proxy-addr';
import { ipTag } from './logger.js';
import { ConnectionCounter, RateLimiter } from './ratelimit.js';
import { SessionStore } from './sessions.js';
import {
  ipKey,
  isClientId,
  isSessionId,
  maskIp,
  normalizeMessage,
  normalizePage,
  summarizeUserAgent,
} from './validate.js';

const HOUR = 3_600_000;
const MAX_SESSIONS = 5000;
const HANDSHAKES_PER_MINUTE = 30;
// Codes Discord signifiant que le fil n'est plus utilisable : Unknown Channel,
// Missing Access, fil archivé, fil verrouillé. Toute autre erreur est passagère.
const THREAD_GONE = new Set([10003, 50001, 50083, 160005]);

export function compileTrust(value) {
  if (typeof value === 'number') return (_addr, i) => i < value;
  return proxyaddr.compile(value);
}

/**
 * Filtre appliqué à chaque nouvelle connexion, avant Socket.IO :
 * en-tête Origin (protège des pages tierces dans un navigateur ; un client hors
 * navigateur peut le falsifier) et cadence de connexion par IP (le vrai garde-fou).
 */
export function connectionFilter({ allowedOrigins, trust }) {
  const handshakes = new RateLimiter({ capacity: HANDSHAKES_PER_MINUTE, perMs: 60_000 });
  const sweeper = setInterval(() => handshakes.sweep(), 60_000);
  sweeper.unref();
  return (req, callback) => {
    const origin = req.headers.origin;
    // Requête « polling » de même origine : le navigateur n'envoie pas d'Origin.
    const originOk = origin ? allowedOrigins.includes(origin) : req.headers['sec-fetch-site'] === 'same-origin';
    if (!originOk) return callback('origin_not_allowed', false);
    if (!handshakes.take(ipKey(proxyaddr(req, trust)))) return callback('too_many_connections', false);
    callback(null, true);
  };
}

class RateLimited extends Error {}

export function attachChat({ io, config, discord, logger }) {
  const log = logger;
  const { limits } = config;
  const trust = compileTrust(config.trustProxy);

  const perSession = new RateLimiter({
    capacity: limits.messageBurst,
    perMs: (limits.messageBurst * 60_000) / limits.messagesPerMinute,
  });
  // Par IP : plus large (plusieurs onglets ou personnes derrière une même IP).
  const perIp = new RateLimiter({
    capacity: limits.messageBurst * 3,
    perMs: (limits.messageBurst * 60_000) / limits.messagesPerMinute,
  });
  const threadsPerIp = new RateLimiter({ capacity: limits.threadsPerIpPerHour, perMs: HOUR });
  const threadsGlobal = new RateLimiter({ capacity: limits.threadsPerHour, perMs: HOUR });
  const connections = new ConnectionCounter(limits.connectionsPerIp);

  const room = (session) => `session:${session.id}`;
  const available = () =>
    discord.isReady() && (config.alwaysAvailable || discord.isAvailable());

  const notice = (threadId, text) =>
    discord.notice(threadId, text).catch((err) => log.warn('discord_notice_failed', { err }));
  const archive = (threadId) =>
    discord.archive(threadId).catch((err) => log.warn('discord_archive_failed', { err }));

  const ttlMinutes = Math.round(config.sessionTtlMs / 60_000);
  const sessions = new SessionStore({
    ttlMs: config.sessionTtlMs,
    graceMs: config.disconnectGraceMs,
    onLeft: (s) => notice(s.threadId, `Le visiteur a quitté le chat. Il retrouvera ce fil s'il revient dans les ${ttlMinutes} min.`),
    onReturn: (s) => s.threadId && notice(s.threadId, 'Le visiteur est de retour.'),
    onExpire: (s) => {
      if (!s.threadId) return;
      const threadId = s.threadId;
      notice(threadId, `Conversation close après ${ttlMinutes} min d'inactivité.`).then(() => archive(threadId));
    },
  });

  const sweeper = setInterval(() => {
    sessions.sweep();
    for (const l of [perSession, perIp, threadsPerIp, threadsGlobal]) l.sweep();
  }, 60_000);
  sweeper.unref();

  function ipForDiscord(ip) {
    if (config.visitorIpInDiscord === 'full') return ip;
    if (config.visitorIpInDiscord === 'masked') return maskIp(ip);
    return null;
  }

  async function ensureThread(session, socket, page) {
    if (session.threadId) return session.threadId;
    if (!session.threadPromise) {
      const { key } = socket.data;
      if (!threadsGlobal.check('all')) {
        log.error('thread_global_limit_reached', { limit: limits.threadsPerHour });
        throw new RateLimited();
      }
      if (!threadsPerIp.check(key)) {
        log.warn('thread_rate_limited', { ip: socket.data.ipTag });
        throw new RateLimited();
      }
      threadsPerIp.take(key);
      threadsGlobal.take('all');
      session.threadPromise = discord
        .createThread({
          sessionId: session.id,
          page,
          userAgent: summarizeUserAgent(socket.handshake.headers['user-agent']),
          ip: ipForDiscord(socket.data.ip),
        })
        .then((threadId) => {
          if (!sessions.has(session)) {
            // Session disparue pendant la création : on ne laisse pas de fil orphelin.
            notice(threadId, 'Le visiteur est parti avant la fin de l\'ouverture de la conversation.').then(() => archive(threadId));
            throw new Error('session_gone');
          }
          sessions.bindThread(session, threadId);
          session.lastPage = page;
          log.info('thread_created', { session: session.id.slice(0, 8), ip: socket.data.ipTag });
          return threadId;
        })
        .finally(() => {
          session.threadPromise = null;
        });
    }
    return session.threadPromise;
  }

  async function handleMessage(socket, session, payload) {
    if (!discord.isReady()) return { ok: false, error: 'unavailable' };
    const normalized = normalizeMessage(payload?.text, config.maxMessageLength);
    if (!normalized.ok) return normalized;
    const { text } = normalized;

    if (!perSession.take(session.id) || !perIp.take(socket.data.key)) {
      log.warn('message_rate_limited', { ip: socket.data.ipTag });
      return { ok: false, error: 'rate_limited' };
    }
    const page = normalizePage(payload?.page, config.allowedOrigins);

    let threadId;
    const deliver = async () => {
      threadId = await ensureThread(session, socket, page);
      const id = await discord.send(threadId, { text, page: page && page !== session.lastPage ? page : null });
      if (page) session.lastPage = page;
      return id;
    };

    let id;
    try {
      try {
        id = await deliver();
      } catch (err) {
        if (err instanceof RateLimited || !threadId || !THREAD_GONE.has(err.code)) throw err;
        // Fil supprimé, verrouillé ou inaccessible : on en ouvre un nouveau.
        log.warn('thread_lost', { code: err.code });
        if (session.threadId === threadId) sessions.unbindThread(threadId);
        id = await deliver();
      }
    } catch (err) {
      if (err instanceof RateLimited) return { ok: false, error: 'rate_limited' };
      log.error('message_delivery_failed', { err, ip: socket.data.ipTag });
      return { ok: false, error: 'unavailable' };
    }

    sessions.touch(session);
    const at = new Date().toISOString();
    socket.to(room(session)).emit('echo', { id, text, at });
    log.info('message_relayed', {
      session: session.id.slice(0, 8),
      length: text.length,
      ...(config.log.messages ? { text } : {}),
    });
    return { ok: true, id, at };
  }

  io.use((socket, next) => {
    const ip = proxyaddr(socket.request, trust);
    const key = ipKey(ip);
    // Connexion déjà refermée (CONNECT et fermeture dans le même lot) : aucun « close »
    // ne viendrait libérer la place, on n'en prend donc pas.
    if (socket.conn.readyState !== 'open') return next(new Error('closed'));
    if (sessions.size >= MAX_SESSIONS) {
      log.error('too_many_sessions', { max: MAX_SESSIONS });
      return next(new Error('server_busy'));
    }
    if (!connections.acquire(key)) {
      log.warn('too_many_connections', { ip: ipTag(key) });
      return next(new Error('too_many_connections'));
    }
    // Libération garantie : la fermeture de la connexion sous-jacente survient toujours,
    // même quand Socket.IO abandonne le socket sans émettre « disconnect ».
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      connections.release(key);
    };
    socket.conn.once('close', release);
    socket.once('disconnect', release);
    socket.data.ip = ip;
    socket.data.key = key;
    socket.data.ipTag = ipTag(key);
    next();
  });

  io.on('connection', (socket) => {
    const requested = socket.handshake.auth?.sessionId;
    const session = sessions.resolve(isSessionId(requested) ? requested : null);
    sessions.attach(session, socket.id);
    socket.join(room(session));
    socket.emit('session', { sessionId: session.id, maxLength: config.maxMessageLength });
    socket.emit('status', { available: available() });
    log.debug('socket_connected', { ip: socket.data.ipTag, resumed: session.id === requested });

    socket.on('message', async (payload, ack) => {
      const respond = typeof ack === 'function' ? ack : () => {};
      const clientId = isClientId(payload?.clientId) ? payload.clientId : null;
      // Renvoi d'un message déjà traité (ack perdu) : même réponse, pas de doublon côté Discord.
      if (clientId && session.recent.has(clientId)) return respond(await session.recent.get(clientId));
      const pending = handleMessage(socket, session, payload);
      if (clientId) sessions.remember(session, clientId, pending);
      const result = await pending;
      if (clientId && !result.ok) session.recent.delete(clientId);
      respond(result);
    });

    socket.on('disconnect', () => sessions.detach(session, socket.id));
  });

  discord.on('ready', () => io.emit('status', { available: available() }));
  discord.on('availability', () => io.emit('status', { available: available() }));

  discord.on('reply', ({ threadId, id, text, at, ack }) => {
    const session = sessions.byThread(threadId);
    if (!session) return ack?.(false);
    sessions.touch(session);
    const delivered = (io.sockets.adapter.rooms.get(room(session))?.size ?? 0) > 0;
    io.to(room(session)).emit('message', { id, text, at });
    ack?.(delivered);
  });

  discord.on('typing', ({ threadId }) => {
    const session = sessions.byThread(threadId);
    if (session) io.to(room(session)).emit('typing', {});
  });

  discord.on('threadClosed', ({ threadId }) => {
    const session = sessions.unbindThread(threadId);
    if (session) io.to(room(session)).emit('closed', {});
  });

  return {
    sessions,
    /** Prévient l'équipe dans les fils ouverts puis libère les ressources (3 s maximum). */
    async close() {
      clearInterval(sweeper);
      const open = sessions.withThread().map((s) =>
        notice(s.threadId, 'Le serveur de chat redémarre : cette conversation est interrompue côté visiteur.').then(() =>
          archive(s.threadId),
        ),
      );
      await Promise.race([Promise.allSettled(open), new Promise((r) => setTimeout(r, 3000).unref())]);
      sessions.clear();
    },
  };
}
