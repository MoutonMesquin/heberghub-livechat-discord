// Faux Discord pour le développement local (`npm run dev:mock`) et les tests :
// même interface que DiscordAdapter, aucune connexion réseau.

import { EventEmitter } from 'node:events';

export class MockDiscordAdapter extends EventEmitter {
  constructor({ logger, autoReply = true, replyDelayMs = 800, available = true } = {}) {
    super();
    this.log = logger;
    this.autoReply = autoReply;
    this.replyDelayMs = replyDelayMs;
    this.available = available;
    this.ready = false;
    this.threads = new Map();
    this.seq = 0;
  }

  isReady() {
    return this.ready;
  }

  isAvailable() {
    return this.available;
  }

  async start() {
    this.ready = true;
    this.log?.warn('discord_mock', { detail: 'Discord simulé : aucune donnée ne quitte ce serveur' });
    this.emit('ready');
  }

  async stop() {
    this.ready = false;
  }

  setAvailable(available) {
    this.available = available;
    this.emit('availability', available);
  }

  async createThread(info) {
    const id = `mock-${++this.seq}`;
    this.threads.set(id, { info, messages: [], notices: [], archived: false });
    return id;
  }

  async send(threadId, { text, page }) {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error('fil introuvable');
    const id = `m${++this.seq}`;
    thread.messages.push({ id, text, page });
    if (this.autoReply) {
      setTimeout(() => {
        this.emit('typing', { threadId });
        setTimeout(() => this.reply(threadId, `Réponse simulée : « ${text.slice(0, 80)} »`), this.replyDelayMs);
      }, 200).unref();
    }
    return id;
  }

  async notice(threadId, text) {
    this.threads.get(threadId)?.notices.push(text);
  }

  async archive(threadId) {
    const thread = this.threads.get(threadId);
    if (thread) thread.archived = true;
  }

  /** Simule une réponse de l'équipe ; renvoie une promesse résolue avec l'état de remise. */
  reply(threadId, text) {
    return new Promise((resolve) => {
      this.emit('reply', { threadId, id: `r${++this.seq}`, text, at: new Date().toISOString(), ack: resolve });
    });
  }

  close(threadId) {
    this.emit('threadClosed', { threadId });
  }
}
