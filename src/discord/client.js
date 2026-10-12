// Adaptateur Discord : tout ce qui touche à l'API Discord passe par ici.
//
// Événements émis :
//   ready
//   availability (available: boolean)
//   reply   ({ threadId, id, text, at, ack(delivered: boolean) })
//   typing  ({ threadId })
//   threadClosed ({ threadId })

import { EventEmitter } from 'node:events';
import {
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  ThreadAutoArchiveDuration,
} from 'discord.js';
import { cleanStaffMessage, escapeForDiscord, threadName } from './format.js';

const COLOR_VISITOR = 0xff9900;
const COLOR_INFO = 0x0066cc;
const COLOR_NOTICE = 0x99aab5;
const ONLINE = new Set(['online', 'idle', 'dnd']);

export class DiscordAdapter extends EventEmitter {
  constructor({ config, logger }) {
    super();
    this.config = config;
    this.cfg = config.discord;
    this.log = logger;
    this.available = false;
    this.forum = null;
    this.recheckTimer = null;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildPresences,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessageTyping,
        GatewayIntentBits.MessageContent,
      ],
      allowedMentions: { parse: [] },
    });
    this.#wire();
  }

  isReady() {
    return this.client.isReady() && this.forum !== null;
  }

  isAvailable() {
    return this.available;
  }

  async start() {
    await this.client.login(this.cfg.token);
  }

  async stop() {
    clearInterval(this.recheckTimer);
    await this.client.destroy();
  }

  #wire() {
    const c = this.client;

    c.once(Events.ClientReady, async () => {
      try {
        const guild = await c.guilds.fetch(this.cfg.guildId);
        const forum = await guild.channels.fetch(this.cfg.forumChannelId);
        if (!forum || forum.type !== ChannelType.GuildForum) {
          throw new Error('DISCORD_FORUM_CHANNEL_ID ne désigne pas un salon forum');
        }
        const role = await guild.roles.fetch(this.cfg.supportRoleId);
        if (!role) throw new Error('DISCORD_SUPPORT_ROLE_ID introuvable sur ce serveur');
        // Un seul chargement complet des membres ; ensuite le cache suit les événements.
        await guild.members.fetch({ withPresences: true });
        this.forum = forum;
        this.log.info('discord_ready', { bot: c.user.tag, forum: forum.name });
        this.#recheck();
        this.recheckTimer = setInterval(() => this.#recheck(), 5 * 60_000);
        this.recheckTimer.unref();
        this.emit('ready');
      } catch (err) {
        this.log.error('discord_setup_failed', { err });
        this.emit('fatal', err);
      }
    });

    c.on(Events.PresenceUpdate, (_old, presence) => {
      if (presence.member?.roles.cache.has(this.cfg.supportRoleId)) this.#recheck();
    });
    c.on(Events.GuildMemberUpdate, () => this.#recheck());
    c.on(Events.GuildMemberRemove, () => this.#recheck());

    c.on(Events.MessageCreate, (message) => this.#onMessage(message));

    c.on(Events.TypingStart, (typing) => {
      if (typing.user?.bot || !this.#isOurThread(typing.channel)) return;
    if (!typing.member?.roles.cache.has(this.cfg.supportRoleId)) return;
      this.emit('typing', { threadId: typing.channel.id });
    });

    c.on(Events.ThreadUpdate, (before, after) => {
      if (!this.#isOurThread(after)) return;
      if ((!before.archived && after.archived) || (!before.locked && after.locked)) {
        this.emit('threadClosed', { threadId: after.id });
      }
    });
    c.on(Events.ThreadDelete, (thread) => {
      if (this.#isOurThread(thread)) this.emit('threadClosed', { threadId: thread.id });
    });

    c.on(Events.ShardDisconnect, () => this.log.warn('discord_disconnected'));
    c.on(Events.ShardResume, () => this.log.info('discord_resumed'));
    c.on(Events.Error, (err) => this.log.error('discord_error', { err }));
    c.on(Events.Warn, (msg) => this.log.warn('discord_warning', { detail: msg }));
  }

  #isOurThread(channel) {
    return Boolean(channel?.isThread?.() && channel.parentId === this.cfg.forumChannelId);
  }

  #recheck() {
    const guild = this.client.guilds.cache.get(this.cfg.guildId);
    const role = guild?.roles.cache.get(this.cfg.supportRoleId);
    const available = Boolean(
      role?.members.some((m) => !m.user.bot && ONLINE.has(m.presence?.status)),
    );
    if (available !== this.available) {
      this.available = available;
      this.log.info('support_availability', { available });
      this.emit('availability', available);
    }
  }

  #onMessage(message) {
    if (message.author.bot || message.system || !this.#isOurThread(message.channel)) return;
    // Seuls les membres du rôle support parlent au visiteur au nom de l'équipe.
    if (!message.member?.roles.cache.has(this.cfg.supportRoleId)) return;
    const prefix = this.config.internalPrefix;
    if (prefix && message.content.startsWith(prefix)) return;
    const text = cleanStaffMessage(message.content, [...message.attachments.values()], {
      timeZone: this.config.timeZone,
    });
    if (!text) return;
    this.emit('reply', {
      threadId: message.channel.id,
      id: message.id,
      text,
      at: message.createdAt.toISOString(),
      ack: (delivered) => {
        message.react(delivered ? '✅' : '💤').catch(() => {});
      },
    });
  }

  async #thread(threadId) {
    const channel = await this.client.channels.fetch(threadId);
    if (!this.#isOurThread(channel)) throw new Error('fil introuvable');
    return channel;
  }

  /** Crée le fil d'une nouvelle conversation et ping le rôle support (une seule fois). */
  async createThread({ sessionId, page, userAgent, ip }) {
    if (!this.isReady()) throw new Error('discord_not_ready');
    const now = new Date();
    const embed = new EmbedBuilder()
      .setColor(COLOR_INFO)
      .setTitle('Nouvelle conversation')
      .setDescription(`Répondez dans ce fil : la réponse s'affiche chez le visiteur.\nLes messages commençant par \`${this.config.internalPrefix}\` restent internes.`)
      .addFields(
        { name: 'Page', value: page ? '`' + page.replace(/`/g, '') + '`' : 'inconnue', inline: false },
        { name: 'Navigateur', value: userAgent, inline: true },
        { name: 'Session', value: `\`${sessionId.slice(0, 8)}\``, inline: true },
      )
      .setTimestamp(now);
    if (ip) embed.addFields({ name: 'IP', value: ip, inline: true });
    const thread = await this.forum.threads.create({
      name: threadName(now, sessionId, this.config.timeZone),
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
      message: {
        content: `<@&${this.cfg.supportRoleId}> un visiteur attend une réponse`,
        embeds: [embed],
        allowedMentions: { roles: [this.cfg.supportRoleId] },
      },
      reason: 'Chat en direct du site',
    });
    return thread.id;
  }

  /** Publie un message du visiteur dans son fil. */
  async send(threadId, { text, page }) {
    const thread = await this.#thread(threadId);
    const embed = new EmbedBuilder()
      .setColor(COLOR_VISITOR)
      .setAuthor({ name: 'Visiteur' })
      .setDescription(escapeForDiscord(text).slice(0, 4096));
    if (page) embed.setFooter({ text: page });
    const sent = await thread.send({ embeds: [embed], allowedMentions: { parse: [] } });
    return sent.id;
  }

  /** Message d'information dans le fil (visiteur parti, revenu, conversation close…). */
  async notice(threadId, text) {
    const thread = await this.#thread(threadId);
    await thread.send({
      embeds: [new EmbedBuilder().setColor(COLOR_NOTICE).setDescription(text)],
      allowedMentions: { parse: [] },
    });
  }

  async archive(threadId) {
    const thread = await this.#thread(threadId);
    if (!thread.archived) await thread.setArchived(true, 'Conversation inactive');
  }
}
