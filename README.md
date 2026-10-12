# HebergHub Live Chat

Chat en direct pour site web, dont les conversations arrivent dans un **salon forum Discord** : un fil par visiteur, l'équipe répond depuis Discord et la réponse s'affiche aussitôt dans le widget.

[![CI](https://github.com/MoutonMesquin/heberghub-livechat-discord/actions/workflows/ci.yml/badge.svg)](https://github.com/MoutonMesquin/heberghub-livechat-discord/actions/workflows/ci.yml)
![Licence MIT](https://img.shields.io/badge/licence-MIT-blue)

- **Widget autonome** : une balise `<script>`, aucune dépendance au CSS du site (Shadow DOM), mode sombre, mobile, accessible au clavier et aux lecteurs d'écran.
- **Un fil Discord par conversation**, conservé quand le visiteur change de page ou perd sa connexion.
- **Présence** : le widget s'affiche quand un membre du rôle support est en ligne (ou un message « hors ligne », au choix).
- **Notes internes** : un message Discord commençant par `!` n'est pas transmis au visiteur.
- **Anti-abus** : limites de débit par session, par IP (IPv6 regroupées par /64) et globales, cadence de connexion limitée, taille des messages bornée.
- **Sobre en données** : pas d'IP en clair dans les journaux ni (par défaut) dans Discord, pas de contenu des messages dans les journaux.

```
Navigateur ──(Socket.IO)──▶ serveur Node.js ──(API Discord)──▶ fil du salon forum
     ▲                                                              │
     └─────────────────────── réponse de l'équipe ◀─────────────────┘
```

## Sommaire
- [Démarrage rapide](#démarrage-rapide)
- [Préparer Discord](#préparer-discord)
- [Intégrer le widget](#intégrer-le-widget)
- [Configuration](#configuration)
- [Déploiement](#déploiement)
- [Côté équipe support](#côté-équipe-support)
- [Sécurité et données personnelles](#sécurité-et-données-personnelles)
- [Développement](#développement)
- [Migration depuis la v1](#migration-depuis-la-v1)

## Démarrage rapide

Sans Discord, pour essayer le widget en local (Node.js 20 ou plus) :

```bash
npm install
npm run dev:mock
```

Ouvrez http://localhost:3000/demo : chaque message reçoit une réponse simulée.

Avec Docker et un vrai bot :

```bash
cp .env.example .env   # puis remplissez-le
docker compose up -d --build
```

## Préparer Discord

1. Créez une application sur le [portail développeur Discord](https://discord.com/developers/applications), onglet **Bot** : générez le jeton (`DISCORD_TOKEN`).
2. Activez les **Privileged Gateway Intents** : *Server Members*, *Presence* et *Message Content*.
3. Invitez le bot (OAuth2 > URL Generator, scope `bot`) avec les permissions : *View Channels*, *Send Messages*, *Send Messages in Threads*, *Create Public Threads*, *Manage Threads* (archivage), *Embed Links*, *Add Reactions*, *Read Message History*.
4. Créez un **rôle support** attribué à l'équipe et rendez-le **mentionnable** (ou donnez au bot *Mention @everyone, @here and All Roles*) : sinon le ping d'ouverture n'envoie aucune notification.
5. Créez un **salon forum privé**, visible seulement par le rôle support et le bot : les conversations contiennent des données de visiteurs. Seuls les messages des membres du rôle support sont transmis au visiteur.
6. Activez le mode développeur de Discord (Paramètres > Avancés) puis copiez les identifiants du serveur, du forum et du rôle (clic droit > *Copier l'identifiant*).

## Intégrer le widget

Le serveur sert lui-même le widget : ajoutez sur chaque page

```html
<script src="https://chat.example.com/widget.js" defer
        data-title="Support"
        data-color="#0066CC"
        data-accent="#FF9900"
        data-privacy-url="/confidentialite"
        data-offline="message"
        data-contact-url="/contact"></script>
```

| Attribut | Rôle | Défaut |
|---|---|---|
| `data-title` | Titre du panneau et nom affiché pour l'équipe | `Support` |
| `data-welcome` | Message d'accueil | `Bonjour ! Comment pouvons-nous vous aider ?` |
| `data-color` / `data-accent` | Couleurs (format `#RRGGBB`) | `#0066CC` / `#FF9900` |
| `data-position` | `right` ou `left` | `right` |
| `data-offline` | `hide` (rien n'est affiché) ou `message` (encart « hors ligne ») | `hide` |
| `data-offline-text` | Texte de l'encart hors ligne | `Notre équipe n'est pas disponible pour le moment.` |
| `data-contact-url` | Lien « Nous écrire » de l'encart hors ligne | — |
| `data-privacy-url` | Lien vers votre politique de confidentialité | — |
| `data-server` | URL du serveur si elle diffère de celle du script | origine du `src` |

L'origine du site doit figurer dans `ALLOWED_ORIGINS`. Si le site a une Content-Security-Policy, autorisez l'origine du serveur dans `script-src` et `connect-src` (`https:` et `wss:`). Les styles du widget passent par une feuille construite (`adoptedStyleSheets`), compatible avec un `style-src` strict sur les navigateurs récents ; les plus anciens retombent sur une balise `<style>`, qui demande `style-src 'unsafe-inline'`.

Le widget expose aussi `window.HebergHubChat.open()`, `.close()` et `.toggle()`, par exemple pour un bouton « Discuter avec nous ».

## Configuration

Toute la configuration passe par des variables d'environnement (voir [`.env.example`](.env.example)). Une valeur invalide arrête le démarrage avec un message explicite.

| Variable | Rôle | Défaut |
|---|---|---|
| `ALLOWED_ORIGINS` | **Obligatoire.** Origines autorisées, séparées par des virgules | — |
| `DISCORD_TOKEN` | **Obligatoire.** Jeton du bot | — |
| `DISCORD_GUILD_ID` | **Obligatoire.** Identifiant du serveur Discord | — |
| `DISCORD_FORUM_CHANNEL_ID` | **Obligatoire.** Salon forum qui reçoit les conversations | — |
| `DISCORD_SUPPORT_ROLE_ID` | **Obligatoire.** Rôle pingé et suivi pour la présence | — |
| `PORT` / `HOST` | Écoute HTTP | `3000` / `0.0.0.0` |
| `TRUST_PROXY` | Nombre de proxys de confiance devant le serveur, ou liste d'adresses (voir [Déploiement](#déploiement)) | `0` |
| `INTERNAL_PREFIX` | Préfixe des notes internes | `!` |
| `ALWAYS_AVAILABLE` | Afficher le widget même sans support en ligne | `false` |
| `VISITOR_IP_IN_DISCORD` | `none`, `masked` (/24, /48) ou `full` | `none` |
| `TIMEZONE` | Fuseau des dates affichées dans Discord | `Europe/Paris` |
| `MAX_MESSAGE_LENGTH` | Longueur maximale d'un message (2000 au plus) | `2000` |
| `SESSION_TTL_MINUTES` | Inactivité avant clôture et archivage du fil | `30` |
| `DISCONNECT_GRACE_SECONDS` | Délai avant d'annoncer le départ du visiteur | `120` |
| `RATE_MESSAGES_PER_MINUTE` / `RATE_MESSAGE_BURST` | Débit de messages par session | `10` / `5` |
| `RATE_THREADS_PER_IP_PER_HOUR` | Nouvelles conversations par IP et par heure | `3` |
| `RATE_THREADS_GLOBAL_PER_HOUR` | Nouvelles conversations par heure, tous visiteurs | `60` |
| `MAX_CONNECTIONS_PER_IP` | Connexions simultanées par IP | `10` |
| `DEMO_PAGE` | Servir la page `/demo` | `false` |
| `LOG_LEVEL` | `debug`, `info`, `warn`, `error` | `info` |
| `LOG_MESSAGES` | Écrire le texte des messages dans les journaux | `false` |

### Routes HTTP

| Route | Usage |
|---|---|
| `GET /widget.js` | Script du widget |
| `GET /api/status` | `{ "available": true }`, mis en cache, lisible par les origines autorisées |
| `GET /healthz` | Vivacité (toujours 200) |
| `GET /readyz` | 200 quand le bot est connecté, 503 sinon |
| `/socket.io/` | Canal temps réel |

## Déploiement

Placez le serveur derrière un proxy inverse HTTPS (Nginx, Traefik, Caddy, Nginx Proxy Manager…) qui laisse passer les WebSocket, puis réglez `TRUST_PROXY` pour que les limites de débit voient l'IP réelle des visiteurs :

- `TRUST_PROXY` = **nombre total de sauts** entre Internet et le serveur. Un proxy inverse seul : `1`. Un tunnel (Cloudflare Tunnel, etc.) puis un proxy inverse : `2`. Plutôt qu'un nombre, vous pouvez donner la liste des adresses de ces proxys (`TRUST_PROXY=10.0.0.5, 10.0.0.6`).
- Trop petit, tous les visiteurs semblent venir du proxy et partagent les mêmes limites ; trop grand, ou serveur joignable sans passer par le proxy, un `X-Forwarded-For` falsifié contourne les limites. N'exposez donc jamais le port du serveur directement.
- Sans valeur, `X-Forwarded-For` est ignoré.

Exemple Nginx :

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

L'image Docker tourne sans privilèges (`node`), en système de fichiers en lecture seule possible, et écrit ses journaux en JSON sur la sortie standard. Le `Dockerfile` est à la racine : il fonctionne tel quel sur Coolify, Dokploy, CapRover, etc.

**Une seule instance par jeton de bot.** Deux serveurs connectés avec le même jeton reçoivent les mêmes messages Discord et les sessions vivent en mémoire : ne multipliez pas les répliques. À l'arrêt (SIGTERM), le serveur prévient l'équipe dans chaque fil ouvert et l'archive ; le visiteur en ouvre un nouveau à son message suivant. Un arrêt brutal (crash, `kill -9`) laisse les fils ouverts.

## Côté équipe support

- Chaque conversation ouvre un fil `Chat · 12/10 14:32 · #a1b2` avec la page d'origine et le navigateur ; le rôle support n'est pingé qu'à l'ouverture.
- Répondez simplement dans le fil. ✅ sur votre message = remis au visiteur, 💤 = le visiteur n'est plus connecté.
- `!texte` : note interne, jamais transmise.
- Seuls les membres du rôle support sont relayés ; les autres messages du fil restent dans Discord.
- Les mentions, salons et émojis personnalisés sont convertis en texte lisible ; les pièces jointes sont envoyées sous forme de lien.
- Fermer ou verrouiller le fil clôt la conversation côté visiteur ; un nouveau message de sa part ouvrira un nouveau fil.
- Après `SESSION_TTL_MINUTES` d'inactivité sans visiteur connecté, le fil est archivé automatiquement.

## Sécurité et données personnelles

Ce qui est traité, et où :

| Donnée | Navigateur | Serveur | Discord | Journaux |
|---|---|---|---|---|
| Texte des messages | `sessionStorage` (50 derniers) | mémoire, le temps de l'envoi | oui | non (sauf `LOG_MESSAGES=true`) |
| Page d'origine (sans paramètres ni ancre) | — | mémoire | oui | non |
| Navigateur / système (résumé) | — | — | oui | non |
| Adresse IP | — | mémoire (limites de débit) | non (sauf `VISITOR_IP_IN_DISCORD`) | empreinte salée, non réversible |

Les messages sont stockés par Discord : mentionnez-le dans votre politique de confidentialité (le widget affiche une mention courte et le lien `data-privacy-url`).

Mesures en place : origines vérifiées pour HTTP **et** WebSocket (contre les pages tierces dans un navigateur ; un script hors navigateur peut falsifier `Origin`, d'où les limites de débit et de cadence de connexion par IP), entrées validées et nettoyées (caractères de contrôle, marques bidi, Markdown et mentions neutralisés côté Discord), mentions Discord désactivées sauf le ping du rôle à l'ouverture, rendu du widget sans `innerHTML` pour les contenus reçus, en-têtes de sécurité (Helmet), taille des trames limitée à 16 Ko, image Docker non root.

Pour signaler une vulnérabilité : voir [SECURITY.md](SECURITY.md).

## Développement

```bash
npm install
npm run dev:mock   # serveur + Discord simulé + page /demo
npm run lint
npm test           # tests unitaires et de bout en bout (Socket.IO réel, Discord simulé)
```

Organisation :

```
src/
  server.js        point d'entrée, arrêt propre
  app.js           assemblage HTTP + Socket.IO
  config.js        lecture et validation des variables d'environnement
  http.js          routes HTTP
  chat.js          relais sockets ↔ fils Discord, limites de débit
  sessions.js      sessions visiteur (reconnexion, départ, expiration)
  ratelimit.js     seaux à jetons
  validate.js      validation des entrées navigateur
  logger.js        journaux JSON
  discord/
    client.js      adaptateur discord.js
    format.js      conversions de texte visiteur ↔ Discord
    mock.js        Discord simulé (dev et tests)
widget/live-chat.js  widget servi sur /widget.js
public/demo.html     page de démonstration
```

### Protocole Socket.IO

| Sens | Événement | Contenu |
|---|---|---|
| client → serveur | *handshake* `auth` | `{ sessionId? }` |
| client → serveur | `message` (avec accusé) | `{ text, page?, clientId? }` → `{ ok: true, id, at }` ou `{ ok: false, error }` |
| serveur → client | `session` | `{ sessionId, maxLength }` |
| serveur → client | `status` | `{ available }` |
| serveur → client | `message` | `{ id, text, at }` (réponse de l'équipe) |
| serveur → client | `echo` | `{ id, text, at }` (message envoyé depuis un autre onglet) |
| serveur → client | `typing` / `closed` | `{}` |

Codes d'erreur : `invalid`, `empty`, `too_long`, `rate_limited`, `unavailable`. Un `clientId` déjà traité renvoie la même réponse sans doublon dans Discord.

## Migration depuis la v1

La v2 n'est pas compatible avec l'ancien `live-chat.js` :

1. Remplacez l'ancien script et le chargement de Socket.IO depuis le CDN par la seule balise `<script src="https://votre-serveur/widget.js" defer>` (le widget ne dépend plus de Tailwind).
2. Ajoutez `ALLOWED_ORIGINS` (et `TRUST_PROXY` derrière un proxy) à votre configuration ; les origines ne sont plus codées en dur.
3. Le dossier `discord-bot/` a disparu : le serveur est à la racine (`npm start` ou `Dockerfile`).
4. `/api/support-availability` devient `/api/status` ; `/health` devient `/healthz` ; la page `test-socket.html` est remplacée par `/demo` (désactivée par défaut).
5. Les journaux ne sont plus écrits dans `logs/` mais sur la sortie standard.

Détail des changements : [CHANGELOG.md](CHANGELOG.md).

## Licence

[MIT](LICENSE) © HebergHub
