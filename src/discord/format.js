// Conversions de texte entre le visiteur et Discord.

/**
 * Texte visiteur → Discord : neutralise le Markdown (liens masqués, titres,
 * mentions, blocs de code…) pour que l'équipe voie exactement ce qui a été tapé.
 * Les mentions sont de toute façon désactivées via allowedMentions.
 */
export function escapeForDiscord(text) {
  return text
    .replace(/[\\`*_~|>#[\]()<:-]/g, (c) => '\\' + c)
    .replace(/@(everyone|here)/g, '@\u200b$1');
}

/**
 * Message de l'équipe → visiteur : remplace les jetons Discord illisibles
 * (mentions, salons, émojis personnalisés, horodatages) et ajoute les pièces jointes.
 */
export function cleanStaffMessage(content, attachments = [], { timeZone = 'Europe/Paris' } = {}) {
  let text = (content ?? '')
    .replace(/<@!?\d+>/g, '@support')
    .replace(/<@&\d+>/g, '@équipe')
    .replace(/<#\d+>/g, '#salon')
    .replace(/<a?:(\w{1,32}):\d+>/g, ':$1:')
    .replace(/<t:(\d{1,13})(?::[tTdDfFR])?>/g, (_, s) =>
      new Date(Number(s) * 1000).toLocaleString('fr-FR', { timeZone, dateStyle: 'short', timeStyle: 'short' }),
    )
    .trim();
  const links = attachments.filter((a) => typeof a?.url === 'string' && a.url.startsWith('https://')).map((a) => a.url);
  if (links.length) text = [text, ...links].filter(Boolean).join('\n');
  return text;
}

export function threadName(date, sessionId, timeZone) {
  const stamp = date.toLocaleString('fr-FR', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  return `Chat · ${stamp} · #${sessionId.slice(0, 4)}`;
}
