// Tests de bout en bout : vrai serveur HTTP + Socket.IO, Discord simulé.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { io as connect } from 'socket.io-client';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { MockDiscordAdapter } from '../src/discord/mock.js';
import { silentLogger } from '../src/logger.js';

const ORIGIN = 'https://www.example.com';

async function setup(env = {}) {
  const config = loadConfig({
    ALLOWED_ORIGINS: ORIGIN,
    DISCORD_TOKEN: 'x',
    DISCORD_GUILD_ID: '123456789012345678',
    DISCORD_FORUM_CHANNEL_ID: '123456789012345679',
    DISCORD_SUPPORT_ROLE_ID: '123456789012345680',
    DISCONNECT_GRACE_SECONDS: '0',
    ...env,
  });
  const discord = new MockDiscordAdapter({ autoReply: false });
  const app = createApp({ config, discord, logger: silentLogger });
  const { port } = await app.listen(0, '127.0.0.1');
  await discord.start();
  const url = `http://127.0.0.1:${port}`;
  const clients = [];
  const client = (opts = {}) => {
    const s = connect(url, {
      transports: ['websocket'],
      extraHeaders: { origin: ORIGIN },
      reconnection: false,
      forceNew: true,
      ...opts,
    });
    clients.push(s);
    return s;
  };
  return {
    url,
    app,
    discord,
    client,
    async close() {
      clients.forEach((c) => c.close());
      await app.close();
    },
  };
}

const once = (socket, event) => new Promise((resolve) => socket.once(event, resolve));
const send = (socket, payload) => socket.timeout(2000).emitWithAck('message', payload);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('chat', () => {
  let t;
  before(async () => {
    t = await setup({ RATE_THREADS_PER_IP_PER_HOUR: '100' });
  });
  after(() => t.close());

  it('refuse les origines non autorisées', async () => {
    const s = t.client({ extraHeaders: { origin: 'https://evil.test' } });
    const err = await once(s, 'connect_error');
    assert.ok(err);
  });

  it('ouvre un fil au premier message et le réutilise après reconnexion', async () => {
    const a = t.client();
    const { sessionId } = await once(a, 'session');
    const res = await send(a, { text: 'Bonjour', page: `${ORIGIN}/offres?x=1`, clientId: 'c1' });
    assert.equal(res.ok, true);
    assert.equal(t.discord.threads.size, 1);
    const [threadId, thread] = [...t.discord.threads][0];
    assert.equal(thread.info.page, `${ORIGIN}/offres`);
    assert.equal(thread.info.ip, null);

    a.close();
    const b = t.client({ auth: { sessionId } });
    assert.equal((await once(b, 'session')).sessionId, sessionId);
    assert.equal((await send(b, { text: 'Toujours là' })).ok, true);
    assert.equal(t.discord.threads.size, 1);
    assert.equal(thread.messages.length, 2);

    // Réponse de l'équipe relayée au visiteur, avec accusé de remise.
    const incoming = once(b, 'message');
    const delivered = await t.discord.reply(threadId, 'Bonjour, que puis-je faire ?');
    assert.equal((await incoming).text, 'Bonjour, que puis-je faire ?');
    assert.equal(delivered, true);
  });

  it('ne duplique pas un message renvoyé avec le même clientId', async () => {
    const s = t.client();
    await once(s, 'session');
    const first = await send(s, { text: 'Une fois', clientId: 'same' });
    const again = await send(s, { text: 'Une fois', clientId: 'same' });
    assert.deepEqual(again, first);
    const thread = [...t.discord.threads.values()].at(-1);
    assert.equal(thread.messages.filter((m) => m.text === 'Une fois').length, 1);
  });

  it('valide les messages', async () => {
    const s = t.client();
    await once(s, 'session');
    assert.deepEqual(await send(s, { text: '' }), { ok: false, error: 'empty' });
    assert.deepEqual(await send(s, { text: 123 }), { ok: false, error: 'invalid' });
    assert.deepEqual(await send(s, { text: 'x'.repeat(2001) }), { ok: false, error: 'too_long' });
    assert.deepEqual(await send(s, null), { ok: false, error: 'invalid' });
  });

  it('ouvre un nouveau fil quand l’équipe clôt la conversation', async () => {
    const s = t.client();
    await once(s, 'session');
    await send(s, { text: 'Premier' });
    const before = t.discord.threads.size;
    const threadId = [...t.discord.threads.keys()].at(-1);
    const closed = once(s, 'closed');
    t.discord.close(threadId);
    await closed;
    await send(s, { text: 'Second' });
    assert.equal(t.discord.threads.size, before + 1);
  });

  it('publie la disponibilité', async () => {
    const res = await fetch(`${t.url}/api/status`, { headers: { origin: ORIGIN } });
    assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
    assert.deepEqual(await res.json(), { available: true });
    const evil = await fetch(`${t.url}/api/status`, { headers: { origin: 'https://evil.test' } });
    assert.equal(evil.headers.get('access-control-allow-origin'), null);
  });

  it('sert le widget et masque la démo par défaut', async () => {
    const widget = await fetch(`${t.url}/widget.js`);
    assert.equal(widget.status, 200);
    assert.match(widget.headers.get('content-type'), /javascript/);
    assert.equal(widget.headers.get('cross-origin-resource-policy'), 'cross-origin');
    assert.equal((await fetch(`${t.url}/demo`)).status, 404);
    assert.equal((await fetch(`${t.url}/`)).status, 404);
    assert.equal((await fetch(`${t.url}/healthz`)).status, 200);
  });
});

describe('anti-abus', () => {
  it('limite le débit des messages', async () => {
    const t = await setup({ RATE_MESSAGE_BURST: '2', RATE_MESSAGES_PER_MINUTE: '2' });
    try {
      const s = t.client();
      await once(s, 'session');
      assert.equal((await send(s, { text: '1' })).ok, true);
      assert.equal((await send(s, { text: '2' })).ok, true);
      assert.deepEqual(await send(s, { text: '3' }), { ok: false, error: 'rate_limited' });
    } finally {
      await t.close();
    }
  });

  it('limite la création de fils par IP', async () => {
    const t = await setup({ RATE_THREADS_PER_IP_PER_HOUR: '1' });
    try {
      const a = t.client();
      await once(a, 'session');
      assert.equal((await send(a, { text: 'a' })).ok, true);
      const b = t.client();
      await once(b, 'session');
      assert.deepEqual(await send(b, { text: 'b' }), { ok: false, error: 'rate_limited' });
      assert.equal(t.discord.threads.size, 1);
    } finally {
      await t.close();
    }
  });

  it('limite les connexions simultanées par IP', async () => {
    const t = await setup({ MAX_CONNECTIONS_PER_IP: '1' });
    try {
      const a = t.client();
      await once(a, 'session');
      const b = t.client();
      const err = await once(b, 'connect_error');
      assert.equal(err.message, 'too_many_connections');
      a.close();
      await sleep(50);
      const c = t.client();
      await once(c, 'session');
    } finally {
      await t.close();
    }
  });

  it('ne garde pas en mémoire les sessions des visiteurs muets', async () => {
    const t = await setup();
    try {
      for (let i = 0; i < 20; i++) {
        const s = t.client();
        await once(s, 'session');
        s.close();
      }
      await sleep(50);
      assert.equal(t.app.chat.sessions.size, 0);
    } finally {
      await t.close();
    }
  });

  it('libère le compteur de connexions même sans « disconnect »', async () => {
    const t = await setup({ MAX_CONNECTIONS_PER_IP: '2' });
    try {
      // Connexion polling fermée dans le même lot que le CONNECT du namespace.
      for (let i = 0; i < 5; i++) {
        const hs = await fetch(`${t.url}/socket.io/?EIO=4&transport=polling`, { headers: { origin: ORIGIN } });
        const sid = JSON.parse((await hs.text()).slice(1)).sid;
        await fetch(`${t.url}/socket.io/?EIO=4&transport=polling&sid=${sid}`, {
          method: 'POST',
          headers: { origin: ORIGIN, 'content-type': 'text/plain' },
          body: '40{}1',
        });
      }
      await sleep(100);
      const s = t.client();
      await once(s, 'session');
    } finally {
      await t.close();
    }
  });

  it('ignore X-Forwarded-For sans proxy de confiance', async () => {
    const t = await setup({ RATE_THREADS_PER_IP_PER_HOUR: '1' });
    try {
      const a = t.client({ extraHeaders: { origin: ORIGIN, 'x-forwarded-for': '198.51.100.1' } });
      await once(a, 'session');
      await send(a, { text: 'a' });
      const b = t.client({ extraHeaders: { origin: ORIGIN, 'x-forwarded-for': '198.51.100.2' } });
      await once(b, 'session');
      assert.deepEqual(await send(b, { text: 'b' }), { ok: false, error: 'rate_limited' });
    } finally {
      await t.close();
    }
  });
});
