/*!
 * HebergHub Live Chat — widget v2 (MIT)
 * https://github.com/MoutonMesquin/heberghub-livechat-discord
 *
 * Intégration :
 *   <script src="https://chat.example.com/widget.js" defer
 *           data-title="Support" data-color="#0066CC" data-accent="#FF9900"
 *           data-privacy-url="/confidentialite" data-offline="message"
 *           data-contact-url="/contact"></script>
 */
(function () {
  'use strict';

  if (window.HebergHubChat) return;
  var script = document.currentScript;
  if (!script || !script.src) return;

  var data = script.dataset;
  var base = (data.server || new URL(script.src, location.href).origin).replace(/\/+$/, '');
  var COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

  var opts = {
    title: data.title || 'Support',
    welcome: data.welcome || 'Bonjour ! Comment pouvons-nous vous aider ?',
    color: COLOR.test(data.color || '') ? data.color : '#0066CC',
    accent: COLOR.test(data.accent || '') ? data.accent : '#FF9900',
    position: data.position === 'left' ? 'left' : 'right',
    offline: data.offline === 'message' ? 'message' : 'hide',
    offlineText: data.offlineText || 'Notre équipe n’est pas disponible pour le moment.',
    contactUrl: safeUrl(data.contactUrl),
    privacyUrl: safeUrl(data.privacyUrl),
  };

  var ERRORS = {
    rate_limited: 'Vous envoyez des messages trop vite, patientez un instant.',
    too_long: 'Message trop long.',
    empty: 'Message vide.',
    invalid: 'Message invalide.',
    unavailable: 'Service momentanément indisponible.',
    timeout: 'Connexion perdue.',
  };
  var RETRYABLE = { rate_limited: 1, unavailable: 1, timeout: 1 };
  var MAX_STORED = 50;
  var STORE_KEY = 'hh-livechat:' + base;
  var STATUS_POLL_MS = 120000;

  var state = load();
  var maxLength = 2000;
  var ui = null;
  var socket = null;
  var socketPromise = null;
  var available = false;
  var mode = 'online';
  var typingTimer = null;
  var unread = 0;
  var nodes = {};

  // ---------------------------------------------------------------- utilitaires

  function safeUrl(value) {
    if (!value) return null;
    try {
      var url = new URL(value, location.href);
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
    } catch {
      return null;
    }
  }

  function load() {
    try {
      var saved = JSON.parse(sessionStorage.getItem(STORE_KEY) || 'null');
      if (saved && Array.isArray(saved.messages)) {
        // Un envoi interrompu par un changement de page est proposé au renvoi.
        saved.messages.forEach(function (m) {
          if (m.status === 'sending') { m.status = 'failed'; m.error = 'timeout'; }
        });
        return saved;
      }
    } catch { /* stockage indisponible */ }
    return { sessionId: null, messages: [], open: false };
  }

  function save() {
    try {
      state.messages = state.messages.slice(-MAX_STORED);
      sessionStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch { /* stockage indisponible */ }
  }

  function randomId() {
    var a = new Uint8Array(12);
    crypto.getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function time(iso) {
    var d = iso ? new Date(iso) : new Date();
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  /** Texte brut + liens http(s) cliquables, sans jamais interpréter de HTML. */
  function renderText(target, text) {
    var parts = String(text).split(/(https?:\/\/[^\s<>"]+)/g);
    for (var i = 0; i < parts.length; i++) {
      if (!parts[i]) continue;
      if (i % 2 === 1 && safeUrl(parts[i])) {
        var a = el('a', null, parts[i]);
        a.href = parts[i];
        a.target = '_blank';
        a.rel = 'noopener noreferrer nofollow';
        target.appendChild(a);
      } else {
        target.appendChild(document.createTextNode(parts[i]));
      }
    }
  }

  // ---------------------------------------------------------------- interface

  var CSS = [
    ':host{all:initial;--c:' + opts.color + ';--a:' + opts.accent + ';--bg:#fff;--fg:#1f2937;--muted:#6b7280;--line:#e5e7eb;--bubble:#f3f4f6;--sys:#fef3c7;',
    'position:fixed;bottom:20px;' + opts.position + ':20px;z-index:2147483000;font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--fg)}',
    '@media (prefers-color-scheme:dark){:host{--bg:#111827;--fg:#f3f4f6;--muted:#9ca3af;--line:#374151;--bubble:#1f2937;--sys:#422006}}',
    '*{box-sizing:border-box}[hidden]{display:none!important}',
    '.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}',
    'button{font:inherit;cursor:pointer}',
    ':focus-visible{outline:3px solid var(--a);outline-offset:2px}',
    '.launcher{position:relative;width:56px;height:56px;border:0;border-radius:50%;background:var(--c);color:#fff;display:grid;place-items:center;box-shadow:0 6px 20px rgba(0,0,0,.25);transition:transform .15s}',
    '.launcher:hover{transform:scale(1.06)}',
    '.launcher svg{width:26px;height:26px}',
    '.badge{position:absolute;top:-4px;right:-4px;min-width:20px;height:20px;padding:0 5px;border-radius:10px;background:var(--a);color:#fff;font-size:12px;font-weight:700;display:grid;place-items:center}',
    '.panel{position:absolute;bottom:72px;' + opts.position + ':0;width:360px;height:520px;max-height:calc(100vh - 110px);display:flex;flex-direction:column;background:var(--bg);border:1px solid var(--line);border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.25);overflow:hidden}',
    'header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 14px;background:var(--c);color:#fff}',
    'h2{margin:0;font-size:15px;font-weight:600}',
    '.sub{margin:2px 0 0;font-size:12px;opacity:.9;display:flex;align-items:center;gap:6px}',
    '.dot{width:8px;height:8px;border-radius:50%;background:#9ca3af}.dot.on{background:#34d399}.dot.wait{background:#fbbf24}',
    '.close{border:0;background:transparent;color:#fff;width:32px;height:32px;border-radius:8px;display:grid;place-items:center}',
    '.close:hover{background:rgba(255,255,255,.15)}.close svg{width:18px;height:18px}',
    '.log{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;overscroll-behavior:contain}',
    '.msg{max-width:82%;display:flex;flex-direction:column;gap:2px}',
    '.msg p{margin:0;padding:8px 11px;border-radius:12px;background:var(--bubble);white-space:pre-wrap;overflow-wrap:anywhere}',
    '.msg.me{align-self:flex-end;align-items:flex-end}.msg.me p{background:var(--c);color:#fff;border-bottom-right-radius:4px}',
    '.msg.support p{border-bottom-left-radius:4px}',
    '.msg.system{align-self:center;max-width:92%;text-align:center}.msg.system p{background:var(--sys);font-size:13px}',
    '.msg a{color:inherit;text-decoration:underline}',
    '.meta{font-size:11px;color:var(--muted)}',
    '.msg.failed p{opacity:.6}.msg.failed .meta{color:#dc2626}',
    '.retry{border:0;background:none;color:inherit;text-decoration:underline;padding:0;font-size:11px}',
    '.typing{display:flex;gap:4px;padding:0 14px 8px}.typing span{width:6px;height:6px;border-radius:50%;background:var(--muted);animation:b 1s infinite}',
    '.typing span:nth-child(2){animation-delay:.15s}.typing span:nth-child(3){animation-delay:.3s}',
    '@keyframes b{0%,80%,100%{opacity:.3}40%{opacity:1}}',
    'form{display:flex;align-items:flex-end;gap:8px;padding:10px;border-top:1px solid var(--line)}',
    'textarea{flex:1;resize:none;max-height:120px;min-height:38px;padding:8px 10px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--fg);font:inherit}',
    'textarea:focus{outline:none;border-color:var(--c);box-shadow:0 0 0 2px color-mix(in srgb,var(--c) 35%,transparent)}',
    '.send{width:38px;height:38px;border:0;border-radius:10px;background:var(--c);color:#fff;display:grid;place-items:center;flex:none}',
    '.send:disabled{opacity:.5;cursor:default}.send svg{width:18px;height:18px}',
    '.foot{margin:0;padding:0 12px 8px;font-size:11px;color:var(--muted);display:flex;justify-content:space-between;gap:8px}',
    '.foot a{color:inherit}',
    '.offline{padding:16px;border-top:1px solid var(--line);text-align:center}.offline a{color:var(--c);font-weight:600}',
    '@media (max-width:480px){.panel{position:fixed;inset:0;width:auto;height:auto;max-height:none;border-radius:0;border:0}:host(.open) .launcher{display:none}}',
    '@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}',
  ].join('');

  var ICON_CHAT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  var ICON_CLOSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
  var ICON_SEND = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/></svg>';

  function mount() {
    if (ui) return;
    var host = el('div');
    host.id = 'hh-livechat';
    var root = host.attachShadow({ mode: 'open' });
    root.innerHTML =
      '<section class="panel" id="panel" role="dialog" aria-labelledby="title" hidden>' +
      '<header><div><h2 id="title"></h2><p class="sub"><span class="dot" aria-hidden="true"></span><span class="status"></span></p></div>' +
      '<button class="close" type="button" aria-label="Fermer le chat">' + ICON_CLOSE + '</button></header>' +
      '<div class="log" role="log" aria-live="polite" aria-label="Messages"></div>' +
      '<div class="typing" hidden><span></span><span></span><span></span><span class="sr">Le support écrit…</span></div>' +
      '<form novalidate><label class="sr" for="input">Votre message</label>' +
      '<textarea id="input" rows="1" placeholder="Écrivez votre message…" autocomplete="off"></textarea>' +
      '<button class="send" type="submit" aria-label="Envoyer">' + ICON_SEND + '</button></form>' +
      '<div class="offline" hidden><p></p></div>' +
      '<p class="foot"><span class="privacy"></span><span class="count" aria-live="polite"></span></p>' +
      '</section>' +
      '<button class="launcher" type="button" aria-controls="panel" aria-expanded="false" aria-label="Ouvrir le chat">' +
      ICON_CHAT + '<span class="badge" hidden></span></button>';

    // Feuille construite si possible : elle n'est pas bloquée par un style-src strict.
    try {
      var sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      root.adoptedStyleSheets = [sheet];
    } catch {
      var style = el('style');
      style.textContent = CSS;
      root.insertBefore(style, root.firstChild);
    }

    var q = function (s) { return root.querySelector(s); };
    ui = {
      host: host,
      panel: q('.panel'),
      launcher: q('.launcher'),
      badge: q('.badge'),
      close: q('.close'),
      status: q('.status'),
      dot: q('.dot'),
      log: q('.log'),
      typing: q('.typing'),
      form: q('form'),
      input: q('textarea'),
      send: q('.send'),
      offline: q('.offline'),
      count: q('.count'),
    };
    q('#title').textContent = opts.title;

    var privacy = q('.privacy');
    privacy.appendChild(document.createTextNode('Messages transmis à notre équipe via Discord. '));
    if (opts.privacyUrl) {
      var link = el('a', null, 'Confidentialité');
      link.href = opts.privacyUrl;
      link.target = '_blank';
      link.rel = 'noopener';
      privacy.appendChild(link);
    }

    var offlineBox = ui.offline.querySelector('p');
    offlineBox.textContent = opts.offlineText + ' ';
    if (opts.contactUrl) {
      var contact = el('a', null, 'Nous écrire');
      contact.href = opts.contactUrl;
      offlineBox.appendChild(contact);
    }

    ui.launcher.addEventListener('click', function () { toggle(); });
    ui.close.addEventListener('click', function () { close(); });
    ui.panel.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
    });
    ui.form.addEventListener('submit', function (e) { e.preventDefault(); submit(); });
    ui.input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
    });
    ui.input.addEventListener('input', onInput);

    ui.log.appendChild(bubble({ from: 'support', text: opts.welcome }));
    state.messages.forEach(function (m) { ui.log.appendChild(nodes[key(m)] = bubble(m)); });

    document.body.appendChild(host);
    renderMode();
    renderStatus();
    // Sur mobile le panneau est plein écran : on ne le rouvre pas à chaque page.
    if (state.open && !matchMedia('(max-width: 480px)').matches) open(false);
  }

  function key(m) {
    return m.clientId || m.id;
  }

  function bubble(m) {
    var wrap = el('div', 'msg ' + m.from + (m.status === 'failed' ? ' failed' : ''));
    var p = el('p');
    renderText(p, m.text);
    wrap.appendChild(p);
    if (m.from === 'system') return wrap;
    var meta = el('span', 'meta');
    if (m.status === 'failed') {
      meta.textContent = 'Non envoyé : ' + (ERRORS[m.error] || ERRORS.unavailable) + ' ';
      if (RETRYABLE[m.error]) {
        var retry = el('button', 'retry', 'Réessayer');
        retry.type = 'button';
        retry.addEventListener('click', function () { deliver(m); });
        meta.appendChild(retry);
      }
    } else if (m.status === 'sending') {
      meta.textContent = 'Envoi…';
    } else if (m.at) {
      meta.textContent = (m.from === 'me' ? 'Vous' : opts.title) + ' · ' + time(m.at);
    }
    wrap.appendChild(meta);
    return wrap;
  }

  function upsert(m) {
    if (!ui) return;
    var k = key(m);
    var node = bubble(m);
    if (nodes[k] && nodes[k].parentNode) nodes[k].parentNode.replaceChild(node, nodes[k]);
    else ui.log.appendChild(node);
    nodes[k] = node;
    ui.log.scrollTop = ui.log.scrollHeight;
  }

  function addMessage(m) {
    if (m.id && state.messages.some(function (x) { return x.id === m.id; })) return;
    state.messages.push(m);
    save();
    upsert(m);
  }

  function system(text) {
    // Jamais deux fois de suite le même avis (reconnexions répétées)
    var last = state.messages[state.messages.length - 1];
    if (last && last.from === 'system' && last.text === text) return;
    addMessage({ clientId: randomId(), from: 'system', text: text });
  }

  function renderStatus() {
    if (!ui) return;
    var connected = socket && socket.connected;
    var label;
    var dot = '';
    if (mode === 'offline') label = 'Hors ligne';
    else if (socket && !connected) { label = 'Connexion…'; dot = 'wait'; }
    else if (available) { label = 'En ligne'; dot = 'on'; }
    else label = 'Absents : nous répondrons dès que possible';
    ui.status.textContent = label;
    ui.dot.className = 'dot ' + dot;
  }

  function renderMode() {
    if (!ui) return;
    ui.form.hidden = mode === 'offline';
    ui.offline.hidden = mode !== 'offline';
  }

  function renderBadge() {
    ui.badge.hidden = unread === 0;
    ui.badge.textContent = unread > 9 ? '9+' : String(unread);
    ui.launcher.setAttribute('aria-label', unread ? 'Ouvrir le chat (' + unread + ' nouveau' + (unread > 1 ? 'x' : '') + ' message' + (unread > 1 ? 's' : '') + ')' : 'Ouvrir le chat');
  }

  function onInput() {
    var input = ui.input;
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    var len = input.value.length;
    ui.count.textContent = len > maxLength * 0.8 ? len + ' / ' + maxLength : '';
    ui.send.disabled = len > maxLength;
  }

  function open(focus) {
    mount();
    ui.panel.hidden = false;
    ui.host.classList.add('open');
    ui.launcher.setAttribute('aria-expanded', 'true');
    state.open = true;
    save();
    unread = 0;
    renderBadge();
    ui.log.scrollTop = ui.log.scrollHeight;
    if (focus !== false) ui.input.focus();
    if (mode === 'online') connect();
  }

  function close() {
    if (!ui) return;
    ui.panel.hidden = true;
    ui.host.classList.remove('open');
    ui.launcher.setAttribute('aria-expanded', 'false');
    ui.launcher.focus();
    state.open = false;
    save();
  }

  function toggle() {
    if (ui && !ui.panel.hidden) close();
    else open();
  }

  // ---------------------------------------------------------------- envoi

  function submit() {
    var text = ui.input.value.trim();
    if (!text || text.length > maxLength) return;
    ui.input.value = '';
    onInput();
    var m = { clientId: randomId(), from: 'me', text: text, at: new Date().toISOString(), status: 'sending' };
    addMessage(m);
    deliver(m);
  }

  function deliver(m) {
    m.status = 'sending';
    delete m.error;
    upsert(m);
    connect().then(function (s) {
      var page = location.origin + location.pathname;
      s.timeout(15000).emit('message', { text: m.text, page: page, clientId: m.clientId }, function (err, res) {
        if (err || !res) { m.status = 'failed'; m.error = 'timeout'; }
        else if (!res.ok) { m.status = 'failed'; m.error = res.error; }
        else { m.status = 'sent'; m.id = res.id; m.at = res.at; }
        save();
        upsert(m);
      });
    }, function () {
      m.status = 'failed';
      m.error = 'unavailable';
      save();
      upsert(m);
    });
  }

  // ---------------------------------------------------------------- temps réel

  /** Charge le client Socket.IO du serveur sans écraser un éventuel `window.io` du site. */
  function loadClient() {
    return new Promise(function (resolve, reject) {
      var previous = window.io;
      var tag = document.createElement('script');
      tag.src = base + '/socket.io/socket.io.min.js';
      tag.async = true;
      tag.onload = function () {
        var client = window.io;
        if (previous !== undefined) window.io = previous;
        else { try { delete window.io; } catch { window.io = undefined; } }
        client ? resolve(client) : reject(new Error('client'));
      };
      tag.onerror = reject;
      document.head.appendChild(tag);
    });
  }

  function connect() {
    if (socketPromise) return socketPromise;
    socketPromise = loadClient().then(function (io) {
      socket = io(base, {
        auth: function (cb) { cb(state.sessionId ? { sessionId: state.sessionId } : {}); },
        reconnectionDelayMax: 10000,
        timeout: 10000,
      });
      socket.on('connect', renderStatus);
      socket.on('disconnect', renderStatus);
      socket.on('connect_error', function (err) {
        renderStatus();
        if (err && err.message === 'too_many_connections') system('Trop de connexions depuis votre réseau, réessayez plus tard.');
      });
      socket.on('session', function (s) {
        var hadConversation = state.messages.some(function (m) { return m.from === 'support' || m.status === 'sent'; });
        if (state.sessionId && s.sessionId !== state.sessionId && hadConversation) {
          // L'ancienne conversation est close côté serveur : on la retire et on ne garde qu'un seul avis,
          // sinon chaque nouvelle session (inactivité, redémarrage du serveur) en ajoutait un autre.
          state.messages = [];
          Object.keys(nodes).forEach(function (k) { if (nodes[k].parentNode) nodes[k].parentNode.removeChild(nodes[k]); delete nodes[k]; });
          system('Votre conversation précédente a expiré : votre prochain message en ouvrira une nouvelle.');
        }
        state.sessionId = s.sessionId;
        if (s.maxLength) maxLength = s.maxLength;
        save();
      });
      socket.on('status', function (s) {
        available = Boolean(s && s.available);
        renderStatus();
      });
      socket.on('message', function (m) {
        clearTimeout(typingTimer);
        ui.typing.hidden = true;
        addMessage({ id: m.id, from: 'support', text: m.text, at: m.at });
        if (ui.panel.hidden) { unread++; renderBadge(); }
      });
      socket.on('echo', function (m) {
        addMessage({ id: m.id, from: 'me', text: m.text, at: m.at, status: 'sent' });
      });
      socket.on('typing', function () {
        ui.typing.hidden = false;
        ui.log.scrollTop = ui.log.scrollHeight;
        clearTimeout(typingTimer);
        typingTimer = setTimeout(function () { ui.typing.hidden = true; }, 8000);
      });
      socket.on('closed', function () {
        system('L’équipe a clos cette conversation. Écrivez pour en ouvrir une nouvelle.');
      });
      return socket;
    });
    socketPromise.catch(function () { socketPromise = null; });
    return socketPromise;
  }

  // ---------------------------------------------------------------- démarrage

  function checkStatus() {
    return fetch(base + '/api/status', { credentials: 'omit', cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : { available: false }; })
      .then(function (s) { return Boolean(s.available); }, function () { return false; });
  }

  function poll() {
    checkStatus().then(function (isAvailable) {
      available = isAvailable;
      if (isAvailable) {
        mode = 'online';
        mount();
        renderMode();
        renderStatus();
        return;
      }
      if (opts.offline === 'message') {
        mode = 'offline';
        mount();
        renderMode();
        renderStatus();
      }
      setTimeout(poll, STATUS_POLL_MS);
    });
  }

  function start() {
    // Conversation en cours dans cet onglet : on la réaffiche quoi qu'il arrive.
    if (state.sessionId && state.messages.length) {
      mount();
      connect();
      return;
    }
    poll();
  }

  window.HebergHubChat = { open: open, close: close, toggle: toggle };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
