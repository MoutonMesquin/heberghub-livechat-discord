import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConfigError, loadConfig } from '../src/config.js';
import { cleanStaffMessage, escapeForDiscord, threadName } from '../src/discord/format.js';
import { ConnectionCounter, RateLimiter } from '../src/ratelimit.js';
import { SessionStore } from '../src/sessions.js';
import { ipKey, isSessionId, maskIp, normalizeMessage, normalizePage, summarizeUserAgent } from '../src/validate.js';

const ORIGINS = ['https://www.example.com'];
const VALID_ENV = {
  ALLOWED_ORIGINS: 'https://www.example.com, https://example.com/',
  DISCORD_TOKEN: 'x',
  DISCORD_GUILD_ID: '123456789012345678',
  DISCORD_FORUM_CHANNEL_ID: '123456789012345679',
  DISCORD_SUPPORT_ROLE_ID: '123456789012345680',
};

describe('config', () => {
  it('lit une configuration complète', () => {
    const c = loadConfig(VALID_ENV);
    assert.deepEqual(c.allowedOrigins, ['https://www.example.com', 'https://example.com']);
    assert.equal(c.trustProxy, 0);
    assert.equal(c.visitorIpInDiscord, 'none');
    assert.equal(c.demoPage, false);
  });

  it('exige les origines et les identifiants Discord', () => {
    assert.throws(() => loadConfig({ ...VALID_ENV, ALLOWED_ORIGINS: '' }), ConfigError);
    assert.throws(() => loadConfig({ ...VALID_ENV, DISCORD_GUILD_ID: 'abc' }), ConfigError);
    assert.throws(() => loadConfig({ ...VALID_ENV, ALLOWED_ORIGINS: 'ftp://x' }), ConfigError);
  });

  it('valide le fuseau horaire et la longueur maximale', () => {
    assert.throws(() => loadConfig({ ...VALID_ENV, TIMEZONE: 'Mars/Olympus' }), /TIMEZONE/);
    assert.throws(() => loadConfig({ ...VALID_ENV, MAX_MESSAGE_LENGTH: '4000' }), /MAX_MESSAGE_LENGTH/);
  });

  it('refuse TRUST_PROXY=true', () => {
    assert.throws(() => loadConfig({ ...VALID_ENV, TRUST_PROXY: 'true' }), /TRUST_PROXY/);
    assert.equal(loadConfig({ ...VALID_ENV, TRUST_PROXY: '1' }).trustProxy, 1);
    assert.deepEqual(loadConfig({ ...VALID_ENV, TRUST_PROXY: 'loopback, 10.0.0.0/8' }).trustProxy, ['loopback', '10.0.0.0/8']);
  });

  it('fournit des valeurs locales en mode simulé', () => {
    const c = loadConfig({}, { mock: true });
    assert.deepEqual(c.allowedOrigins, ['http://localhost:3000', 'http://127.0.0.1:3000']);
    assert.equal(c.demoPage, true);
  });
});

describe('validate', () => {
  it('normalise les messages', () => {
    assert.deepEqual(normalizeMessage('  bonjour\r\n ', 100), { ok: true, text: 'bonjour' });
    assert.deepEqual(normalizeMessage('a\u202Eb\u0000c', 100), { ok: true, text: 'abc' });
    assert.deepEqual(normalizeMessage('   ', 100), { ok: false, error: 'empty' });
    assert.deepEqual(normalizeMessage({}, 100), { ok: false, error: 'invalid' });
    assert.deepEqual(normalizeMessage('x'.repeat(101), 100), { ok: false, error: 'too_long' });
    assert.equal(normalizeMessage('é'.repeat(100), 100).ok, true);
  });

  it('ne garde que les pages des origines autorisées, sans paramètres', () => {
    assert.equal(normalizePage('https://www.example.com/a?token=1#x', ORIGINS), 'https://www.example.com/a');
    assert.equal(normalizePage('https://evil.test/a', ORIGINS), null);
    assert.equal(normalizePage('javascript:alert(1)', ORIGINS), null);
    assert.equal(normalizePage(42, ORIGINS), null);
  });

  it('vérifie le format des identifiants de session', () => {
    assert.equal(isSessionId('3b241101-e2bb-4255-8caf-4136c566a962'), true);
    assert.equal(isSessionId('../../etc'), false);
  });

  it('résume le navigateur et masque les IP', () => {
    assert.equal(summarizeUserAgent('Mozilla/5.0 (Windows NT 10.0) Gecko/20100101 Firefox/130.0'), 'Firefox · Windows');
    assert.equal(maskIp('::ffff:203.0.113.42'), '203.0.113.x');
    assert.equal(maskIp('2001:db8:1234:5678::1'), '2001:0db8:1234::/48');
    assert.equal(maskIp('2a01::1234:5678'), '2a01:0000:0000::/48');
    assert.equal(maskIp('n/a'), 'inconnue');
  });

  it('regroupe les IPv6 par /64 pour les limites', () => {
    assert.equal(ipKey('2001:db8:1:2:aaaa::1'), ipKey('2001:db8:1:2:bbbb::2'));
    assert.notEqual(ipKey('2001:db8:1:2::1'), ipKey('2001:db8:1:3::1'));
    assert.equal(ipKey('::ffff:203.0.113.4'), '203.0.113.4');
  });
});

describe('format Discord', () => {
  it('neutralise le Markdown et les mentions du visiteur', () => {
    const out = escapeForDiscord('[clic](https://evil.test) @everyone **gras** <@&1>');
    assert.ok(!out.includes('[clic](https'));
    assert.ok(out.includes('@\u200beveryone'));
    assert.ok(out.includes('\\*\\*gras\\*\\*'));
  });

  it('rend lisibles les messages de l’équipe', () => {
    const text = cleanStaffMessage('Salut <@123456789012345678>, voir <#123456789012345678> <:ok:123456789012345678>', [
      { url: 'https://cdn.discordapp.com/a.png' },
      { url: 'http://insecure' },
    ]);
    assert.equal(text, 'Salut @support, voir #salon :ok:\nhttps://cdn.discordapp.com/a.png');
  });

  it('nomme les fils sans donnée personnelle', () => {
    const name = threadName(new Date('2026-10-12T12:30:00Z'), 'abcdef12-0000', 'Europe/Paris');
    assert.equal(name, 'Chat · 12/10 14:30 · #abcd');
  });
});

describe('ratelimit', () => {
  it('limite puis recharge', () => {
    let t = 0;
    const rl = new RateLimiter({ capacity: 2, perMs: 1000, now: () => t });
    assert.equal(rl.take('a'), true);
    assert.equal(rl.take('a'), true);
    assert.equal(rl.take('a'), false);
    assert.equal(rl.take('b'), true);
    t = 500;
    assert.equal(rl.take('a'), true);
    assert.equal(rl.take('a'), false);
    t = 10_000;
    rl.sweep();
    assert.equal(rl.buckets.size, 0);
  });

  it('compte les connexions', () => {
    const c = new ConnectionCounter(1);
    assert.equal(c.acquire('ip'), true);
    assert.equal(c.acquire('ip'), false);
    c.release('ip');
    assert.equal(c.acquire('ip'), true);
  });
});

describe('sessions', () => {
  it('reprend une session existante et en crée une sinon', () => {
    const store = new SessionStore({ ttlMs: 1000, graceMs: 0 });
    const s = store.resolve(null);
    assert.equal(store.resolve(s.id), s);
    assert.notEqual(store.resolve('3b241101-e2bb-4255-8caf-4136c566a962'), s);
  });

  it('expire les sessions inactives et libère le fil', () => {
    let t = 0;
    const expired = [];
    const store = new SessionStore({ ttlMs: 1000, graceMs: 0, now: () => t, onExpire: (s) => expired.push(s) });
    const s = store.resolve(null);
    store.bindThread(s, 'T1');
    t = 2000;
    store.sweep();
    assert.equal(expired.length, 1);
    assert.equal(store.byThread('T1'), undefined);
  });

  it('signale le départ après le délai de grâce, puis le retour', async () => {
    const events = [];
    const store = new SessionStore({
      ttlMs: 60_000,
      graceMs: 10,
      onLeft: () => events.push('left'),
      onReturn: () => events.push('return'),
    });
    const s = store.resolve(null);
    store.bindThread(s, 'T1');
    store.attach(s, 'a');
    store.detach(s, 'a');
    await new Promise((r) => setTimeout(r, 30));
    store.attach(s, 'b');
    assert.deepEqual(events, ['left', 'return']);
  });

  it('oublie une session sans fil quand le visiteur part', async () => {
    const store = new SessionStore({ ttlMs: 60_000, graceMs: 5 });
    const s = store.resolve(null);
    store.attach(s, 'a');
    store.detach(s, 'a');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(store.size, 0);
  });
});
