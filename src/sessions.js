// Sessions visiteur : une session = un onglet de navigateur (sessionStorage),
// rattachée à au plus un fil Discord, et à zéro ou plusieurs sockets.

import { randomUUID } from 'node:crypto';

const RECENT_IDS = 20;

export class SessionStore {
  /**
   * @param {object} opts
   * @param {number} opts.ttlMs     inactivité au-delà de laquelle une session est close
   * @param {number} opts.graceMs   délai avant de considérer qu'un visiteur déconnecté est parti
   * @param {(session) => void} [opts.onLeft]    visiteur parti (plus aucun socket après le délai de grâce)
   * @param {(session) => void} [opts.onReturn]  visiteur revenu après onLeft
   * @param {(session) => void} [opts.onExpire]  session supprimée pour inactivité
   * @param {() => number} [opts.now]
   */
  constructor({ ttlMs, graceMs, onLeft = () => {}, onReturn = () => {}, onExpire = () => {}, now = Date.now }) {
    Object.assign(this, { ttlMs, graceMs, onLeft, onReturn, onExpire, now });
    this.sessions = new Map();
    this.threads = new Map();
  }

  get size() {
    return this.sessions.size;
  }

  get(id) {
    return this.sessions.get(id);
  }

  /** Retrouve la session demandée par le client, ou en crée une nouvelle. */
  resolve(requestedId) {
    const existing = requestedId && this.sessions.get(requestedId);
    if (existing) return existing;
    const session = {
      id: randomUUID(),
      threadId: null,
      threadPromise: null,
      sockets: new Set(),
      lastActivity: this.now(),
      lastPage: null,
      leftTimer: null,
      leftNotified: false,
      recent: new Map(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  byThread(threadId) {
    const id = this.threads.get(threadId);
    return id ? this.sessions.get(id) : undefined;
  }

  attach(session, socketId) {
    session.sockets.add(socketId);
    this.touch(session);
    if (session.leftTimer) {
      clearTimeout(session.leftTimer);
      session.leftTimer = null;
    }
    if (session.leftNotified) {
      session.leftNotified = false;
      this.onReturn(session);
    }
  }

  detach(session, socketId) {
    session.sockets.delete(socketId);
    if (session.sockets.size > 0 || session.leftTimer) return;
    if (!session.threadId && !session.threadPromise) {
      // Rien n'a été écrit : inutile de garder la session (et de se laisser inonder).
      this.#delete(session);
      return;
    }
    session.leftTimer = setTimeout(() => {
      session.leftTimer = null;
      if (session.sockets.size > 0 || !this.sessions.has(session.id)) return;
      if (!session.threadId) {
        // Personne n'a rien écrit : rien à garder.
        this.#delete(session);
        return;
      }
      session.leftNotified = true;
      this.onLeft(session);
    }, this.graceMs);
    session.leftTimer.unref?.();
  }

  touch(session) {
    session.lastActivity = this.now();
  }

  bindThread(session, threadId) {
    session.threadId = threadId;
    this.threads.set(threadId, session.id);
  }

  has(session) {
    return this.sessions.get(session.id) === session;
  }

  /** Sessions rattachées à un fil (pour prévenir l'équipe à l'arrêt du serveur). */
  withThread() {
    return [...this.sessions.values()].filter((s) => s.threadId);
  }

  /** Le fil a été clos côté Discord : le prochain message en ouvrira un nouveau. */
  unbindThread(threadId) {
    const session = this.byThread(threadId);
    this.threads.delete(threadId);
    if (session && session.threadId === threadId) session.threadId = null;
    return session;
  }

  /** Mémorise la réponse à un message client (pour répondre à l'identique en cas de renvoi). */
  remember(session, clientId, result) {
    session.recent.set(clientId, result);
    if (session.recent.size > RECENT_IDS) session.recent.delete(session.recent.keys().next().value);
  }

  /** Supprime les sessions inactives sans socket ouvert. */
  sweep() {
    const limit = this.now() - this.ttlMs;
    for (const session of this.sessions.values()) {
      if (session.sockets.size === 0 && session.lastActivity < limit) {
        this.#delete(session);
        this.onExpire(session);
      }
    }
  }

  #delete(session) {
    if (session.leftTimer) clearTimeout(session.leftTimer);
    this.sessions.delete(session.id);
    if (session.threadId) this.threads.delete(session.threadId);
  }

  clear() {
    for (const session of this.sessions.values()) if (session.leftTimer) clearTimeout(session.leftTimer);
    this.sessions.clear();
    this.threads.clear();
  }
}
