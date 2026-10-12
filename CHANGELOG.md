# Journal des modifications

## 2.0.0 — 2026-10-12

Réécriture complète. Voir la section « Migration depuis la v1 » du README.

### Sécurité
- Limites de débit : messages par session et par IP (IPv6 par /64), nouvelles conversations par IP et globales, connexions simultanées et cadence de connexion par IP, plafond de sessions.
- Contrôle de l'en-tête `Origin` pour le WebSocket comme pour HTTP ; suppression du repli `Access-Control-Allow-Origin: *`.
- `X-Forwarded-For` n'est plus cru sans `TRUST_PROXY` explicite.
- Validation des messages (type, longueur, caractères de contrôle et bidi) et des URL de page (origines autorisées, sans paramètres).
- Markdown, liens masqués et mentions du visiteur neutralisés dans Discord ; le rôle support n'est pingé qu'à l'ouverture d'un fil.
- Seuls les membres du rôle support sont relayés au visiteur.
- `/api/status` ne sollicite plus l'API Discord à chaque requête (présence suivie par événements).
- En-têtes de sécurité (Helmet), trames limitées à 16 Ko, image Docker non root sans `.env` ni journaux.
- Plus d'IP en clair dans les journaux ni, par défaut, dans Discord ; plus de texte des messages dans les journaux.

### Fonctionnalités
- Widget autonome servi par le serveur (`/widget.js`) : Shadow DOM, aucune dépendance à Tailwind, configuration par attributs `data-*`, mode sombre, plein écran sur mobile, accessibilité (ARIA, clavier).
- Sessions persistantes : reconnexion et changement de page dans le même fil, historique conservé dans l'onglet.
- Accusé d'envoi, renvoi sans doublon, indicateur « le support écrit », compteur de non-lus.
- Notes internes (`!`), réactions ✅/💤 de remise, clôture d'un fil répercutée chez le visiteur, archivage automatique après inactivité et à l'arrêt du serveur.
- Mode hors ligne optionnel (`data-offline="message"`).
- Mode simulé (`npm run dev:mock`) et page `/demo`.

### Technique
- Code découpé en modules ES, Node.js 20+, Express 5, discord.js 14, Socket.IO 4.8.
- Tests unitaires et de bout en bout (`node:test`), ESLint, CI GitHub Actions (tests, build Docker, gitleaks), Dependabot.
- `Dockerfile` à la racine, `compose.yaml` durci, journaux JSON sur la sortie standard, arrêt propre sur SIGTERM.
- Licence MIT ajoutée.

## 1.0.0 — 2025-06-02

Première version publique.
