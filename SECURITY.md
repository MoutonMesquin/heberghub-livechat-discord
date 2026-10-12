# Politique de sécurité

## Signaler une vulnérabilité

Merci de **ne pas ouvrir de ticket public** pour une faille de sécurité.

Utilisez le signalement privé de GitHub : onglet **Security** du dépôt > **Report a vulnerability**. Indiquez la version concernée, les étapes de reproduction et l'impact estimé.

Nous accusons réception sous 7 jours et vous tenons informé du correctif. Merci de nous laisser le temps de publier une version corrigée avant toute divulgation.

## Versions maintenues

| Version | Maintenue |
|---|---|
| 2.x | oui |
| 1.x | non |

## Bonnes pratiques de déploiement

- Ne committez jamais le fichier `.env` ni le jeton du bot ; régénérez le jeton au moindre doute (portail développeur Discord > Bot > *Reset Token*).
- Limitez `ALLOWED_ORIGINS` à vos propres sites.
- Derrière un proxy inverse, réglez `TRUST_PROXY` sur le nombre exact de proxys ; n'exposez pas le port du serveur directement sur Internet.
- Donnez au bot uniquement les permissions listées dans le README, sur le seul salon forum du chat.
