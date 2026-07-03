import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { createWriteStream } from "node:fs";
import {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  type TextChannel,
  type Message,
  type Interaction,
} from "discord.js";
import type {
  ChannelAdapter,
  ApprovalHandle,
  SendOpts,
  SentMessage,
  PermissionPrompt,
  Choice,
  AlertData,
} from "../types.js";
import type { AccessManager } from "../access-manager.js";
import { MessageQueue } from "../message-queue.js";

const DISCORD_MAX_LENGTH = 2000;

export interface DiscordAdapterOptions {
  id: string;
  botToken: string;
  accessManager: AccessManager;
  inboxDir: string;
  guildId: string;
  categoryName?: string;
  generalChannelId?: string;
  registerCommands?: boolean;
}

export class DiscordAdapter extends EventEmitter implements ChannelAdapter {
  readonly type = "discord";
  readonly topology = "channels" as const;
  readonly id: string;

  private client: Client;
  private botToken: string;
  private accessManager: AccessManager;
  private inboxDir: string;
  private guildId: string;
  private openChannels = new Set<string>();
  private categoryName: string;
  private generalChannelId?: string;
  private registerCommands: boolean;
  private queue: MessageQueue;
  private lastChatId: string | null = null;
  private attachmentUrls = new Map<string, string>();
  private categoryIdPromise?: Promise<string>;

  constructor(opts: DiscordAdapterOptions) {
    super();
    this.id = opts.id;
    this.botToken = opts.botToken;
    this.accessManager = opts.accessManager;
    this.inboxDir = opts.inboxDir;
    this.guildId = opts.guildId;
    this.categoryName = opts.categoryName ?? "AgEnD Agents";
    this.generalChannelId = opts.generalChannelId;
    this.registerCommands = opts.registerCommands !== false;

    mkdirSync(this.inboxDir, { recursive: true });

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    this.queue = new MessageQueue({
      send: async (chatId, threadId, text) => {
        const channel = await this._fetchTextChannel(threadId ?? chatId);
        const msg = await channel.send(text);
        return { messageId: msg.id };
      },
      edit: async (chatId, messageId, text) => {
        const channel = await this._fetchTextChannel(chatId);
        const msg = await channel.messages.fetch(messageId);
        await msg.edit(text);
      },
      sendFile: async (chatId, threadId, filePath) => {
        const channel = await this._fetchTextChannel(threadId ?? chatId);
        const msg = await channel.send({ files: [filePath] });
        return { messageId: msg.id };
      },
    });

    this._registerHandlers();
  }

  private async _fetchTextChannel(channelId: string): Promise<TextChannel> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel?.isTextBased()) {
      throw new Error(`Channel ${channelId} is not a text channel`);
    }
    return channel as TextChannel;
  }

  private _registerHandlers(): void {
    // Client/shard errors (WebSocket hiccups, gateway resumes, etc.). discord.js
    // auto-reconnects; we just need a listener so Node's EventEmitter doesn't
    // rethrow on "error" — without one it surfaces as an uncaughtException and
    // the process-level handler tears down the whole fleet (the built-in adapter
    // shares the fleet process).
    this.client.on("error", (err) => console.warn(`[discord] client error: ${(err as Error)?.message ?? err}`));
    this.client.on("shardError", (err) => console.warn(`[discord] shard error: ${(err as Error)?.message ?? err}`));

    this.client.on("messageCreate", async (msg: Message) => {
      try {
      if (msg.author.id === this.client.user?.id) return; // Ignore own messages
      if (!msg.guildId) return;
      if (msg.guildId !== this.guildId) {
        if (!this.openChannels.has(msg.channelId)) return;
        // Allowed: an open classic channel in a non-primary guild.
      }

      const userId = msg.author.id;

      // Access control moved to fleet-manager to allow classic channels for all users

      const chatId = this.guildId;
      const threadId = msg.channelId;
      const messageId = msg.id;
      const username = msg.author.username;
      let text = msg.content;

      // Handle forwarded messages (messageSnapshots) and embeds
      if (!text) {
        const parts: string[] = [];
        // Forwarded message snapshots (Discord forward feature)
        if ((msg as any).messageSnapshots?.size > 0) {
          for (const [, snap] of (msg as any).messageSnapshots) {
            if (snap.message?.content) parts.push(snap.message.content);
            if (snap.message?.embeds?.length) {
              for (const e of snap.message.embeds) {
                if (e.title) parts.push(e.title);
                if (e.description) parts.push(e.description);
              }
            }
            // Forward attachments (images, files) into the main message
            if (snap.message?.attachments?.size > 0) {
              for (const [, att] of snap.message.attachments) {
                msg.attachments.set(att.id, att);
              }
            }
          }
        }
        // Rich embeds (links, bot messages, etc.)
        if (parts.length === 0 && msg.embeds.length > 0) {
          for (const e of msg.embeds) {
            if (e.title) parts.push(e.title);
            if (e.description) parts.push(e.description);
            if (e.fields?.length) {
              for (const f of e.fields) parts.push(`${f.name}: ${f.value}`);
            }
          }
        }
        if (parts.length > 0) text = parts.join("\n");
      }
      const isBotMessage = msg.author.bot;

      // Collect attachments
      const attachments = msg.attachments.map((att) => ({
        kind: (att.contentType?.startsWith("image/") ? "photo"
          : att.contentType?.startsWith("video/") ? "video"
          : att.contentType?.startsWith("audio/") ? "audio"
          : "document") as "photo" | "video" | "audio" | "document",
        fileId: att.id,
        mime: att.contentType ?? undefined,
        size: att.size,
        filename: att.name ?? undefined,
      }));

      // Store attachment URLs for later download
      for (const att of msg.attachments.values()) {
        this.attachmentUrls.set(att.id, att.url);
      }
      while (this.attachmentUrls.size > 1000) {
        const first = this.attachmentUrls.keys().next().value;
        if (first) this.attachmentUrls.delete(first);
        else break;
      }

      let replyToText: string | undefined;
      if (msg.reference?.messageId) {
        try {
          const ref = await msg.fetchReference();
          replyToText = ref.content || ref.embeds?.[0]?.description || undefined;
        } catch { /* deleted message or no permission */ }
      }

      this.emit("message", {
        source: "discord",
        adapterId: this.id,
        chatId,
        threadId,
        messageId,
        userId,
        username,
        text,
        timestamp: msg.createdAt,
        isBotMessage,
        attachments: attachments.length > 0 ? attachments : undefined,
        replyTo: msg.reference?.messageId ?? undefined,
        replyToText,
      });
      } catch (err) {
        // A throw here would become an unhandledRejection → process.exit(1) for
        // the whole fleet. Contain it like the interactionCreate handler does.
        console.warn(`[discord] messageCreate handler error (${(err as Error).message})`);
      }
    });

    // Handle button interactions and slash commands
    // Trust boundary: interaction responses can throw DiscordAPIError[10062] if the
    // interaction expires (>3s). Catch to prevent crashing the entire daemon.
    this.client.on("interactionCreate", async (interaction: Interaction) => {
      try {
        // Buttons: acknowledge IMMEDIATELY, before any guild/channel filtering.
        // A button has a 3s ack window; any early return (unknown guild/channel)
        // or a downstream no-op (e.g. the cancel button was already cleared) would
        // otherwise leave it unacknowledged and Discord shows "interaction failed /
        // expired" right away. deferUpdate is a no-op edit, safe even if we then
        // decide not to act on it.
        if (interaction.isButton()) {
          try { await interaction.deferUpdate(); } catch { /* already acknowledged / unknown interaction */ }
          // Only act on buttons from the primary guild or a known open channel.
          if (interaction.guildId !== this.guildId && !this.openChannels.has(interaction.channelId ?? "")) {
            // console.log(`[discord] ignoring button from non-primary guild ${interaction.guildId} channel ${interaction.channelId}`);
            return;
          }
          this.emit("callback_query", {
            callbackData: interaction.customId,
            chatId: this.guildId,
            threadId: interaction.channelId,
            messageId: interaction.message.id,
          });
          return;
        }

        if (interaction.guildId !== this.guildId) {
          // Allow slash commands through — guild whitelist is checked by fleet-manager.
          if (!interaction.isChatInputCommand() && !this.openChannels.has(interaction.channelId ?? "")) return;
        }

        if (interaction.isChatInputCommand()) {
          const channelName = interaction.channel && "name" in interaction.channel ? (interaction.channel.name ?? "") : "";
          const username = interaction.user.username;
          if (interaction.commandName === "chat") {
            const text = interaction.options.getString("message") ?? "";
            await interaction.deferReply();
            this.emit("slash_command", {
              command: "chat",
              channelId: interaction.channelId,
              channelName,
              guildId: interaction.guildId ?? undefined,
              userId: interaction.user.id,
              username,
              text,
              respond: async (reply: string) => { try { const m = await interaction.editReply(reply); return m.id; } catch { return undefined; } },
            });
          } else {
            await interaction.deferReply({ ephemeral: true });
            // Extract options as key-value pairs for fleet-manager
            const options: Record<string, string | boolean> = {};
            for (const opt of interaction.options.data) {
              options[opt.name] = opt.value as string | boolean;
            }
            this.emit("slash_command", {
              command: interaction.commandName,
              channelId: interaction.channelId,
              channelName,
              guildId: interaction.guildId ?? undefined,
              userId: interaction.user.id,
              username,
              options,
              respond: async (reply: string) => { try { await interaction.editReply(reply); } catch { /* expired */ } },
            });
          }
        }
      } catch (err) {
        console.warn(`[discord] interactionCreate error (${(err as Error).message})`);
      }
    });

    // Handle channel deletion (equivalent to topic_closed)
    this.client.on("guildCreate", (guild) => {
      this.emit("new_group_detected", {
        groupId: guild.id,
        groupTitle: guild.name,
        source: "discord",
      });
    });

    this.client.on("channelDelete", (channel) => {
      if (!("guildId" in channel)) return;
      if (channel.guildId !== this.guildId) {
        if (!this.openChannels.has(channel.id)) return;
        // Allowed: an open classic channel in a non-primary guild was deleted.
      }
      this.emit("topic_closed", {
        chatId: this.guildId,
        threadId: channel.id,
      });
    });
  }

  /** Mark channels as open (skip access control) — used for classic bot channels */
  setOpenChannels(channelIds: string[]): void {
    this.openChannels = new Set(channelIds);
    // console.log(`[AgEnD] setOpenChannels: ${channelIds.length} channels`, channelIds);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.queue.start();

    this.client.once("ready", async () => {
      // Register classic bot slash commands (skipped for a secondary bot sharing
      // a guild with the primary — only the primary owns the guild's commands).
      if (this.registerCommands) try {
        await this.client.application?.commands.set([
          { name: "start", description: "Start an agent in this channel" },
          { name: "stop", description: "Stop the agent in this channel" },
          {
            name: "chat", description: "Send a message to the agent",
            options: [{ name: "message", description: "Your message", type: 3, required: true }],
          },
          { name: "status", description: "Show fleet status and costs" },
          { name: "sysinfo", description: "System diagnostics" },
          { name: "ctx", description: "Show agent context usage" },
          { name: "restart", description: "🔒 Graceful restart all instances" },
          { name: "update", description: "🔒 Update AgEnD to latest version" },
          { name: "doctor", description: "🔒 Run health diagnostics" },
          { name: "compact", description: "🔒 Compact agent context window" },
          { name: "collab", description: "🔒 Toggle bot/webhook collaboration mode" },
          {
            name: "save", description: "🔒 Save the agent's conversation",
            options: [
              { name: "filename", description: "File name to save as", type: 3, required: true },
              { name: "force", description: "Overwrite if file exists", type: 5, required: false },
            ],
          },
          {
            name: "load", description: "🔒 Load a saved conversation",
            options: [{ name: "filename", description: "File name to load", type: 3, required: true }],
          },
          { name: "cancel", description: "Interrupt the agent's current operation (sends Escape)" },
        ]);
      } catch (err) {
        // Non-fatal — slash commands may fail on network issues
      }
      this.emit("started", this.client.user?.username ?? "discord-bot", this.client.user?.id);
    });

    await this.client.login(this.botToken);
  }

  async stop(): Promise<void> {
    this.queue.stop();
    this.client.destroy();
  }

  // ── Text / file sending ────────────────────────────────────────────────

  async sendText(chatId: string, text: string, opts?: SendOpts): Promise<SentMessage> {
    const channelId = opts?.threadId ?? chatId;
    const channel = await this._fetchTextChannel(channelId);
    const chunkLimit = opts?.chunkLimit ?? DISCORD_MAX_LENGTH;

    const chunks = splitText(text, chunkLimit);
    if (chunks.length === 0) throw new Error("Empty text");

    const first = await channel.send(chunks[0]);

    // Enqueue remaining chunks
    for (let i = 1; i < chunks.length; i++) {
      this.queue.enqueue(chatId, opts?.threadId, { type: "content", text: chunks[i] });
    }

    return {
      messageId: first.id,
      chatId,
      threadId: opts?.threadId,
    };
  }

  async sendFile(chatId: string, filePath: string, opts?: SendOpts): Promise<SentMessage> {
    const channelId = opts?.threadId ?? chatId;
    const channel = await this._fetchTextChannel(channelId);
    const msg = await channel.send({ files: [filePath] });
    return { messageId: msg.id, chatId, threadId: opts?.threadId };
  }

  async editMessage(chatId: string, messageId: string, text: string, threadId?: string): Promise<void> {
    // Prefer the exact channel (handles forum-topic threads, which a GuildText
    // scan misses). chatId is the guild id in the channels topology, so the
    // message actually lives in threadId (when set) or a specific text channel.
    try {
      const channel = await this._fetchTextChannel(threadId ?? chatId);
      const msg = await channel.messages.fetch(messageId);
      await msg.edit(text.slice(0, DISCORD_MAX_LENGTH));
      return;
    } catch { /* not in that channel — fall through to scan */ }
    try {
      const guild = await this.client.guilds.fetch(this.guildId);
      const channels = guild.channels.cache.filter(
        (c) => c.type === ChannelType.GuildText,
      );
      for (const [, ch] of channels) {
        try {
          const textCh = ch as TextChannel;
          const msg = await textCh.messages.fetch(messageId);
          await msg.edit(text.slice(0, DISCORD_MAX_LENGTH));
          return;
        } catch {
          continue;
        }
      }
      throw new Error(`Message ${messageId} not found in any channel`);
    } catch (err) {
      // Fallback: send a new message if edit fails
      if (this.generalChannelId) {
        const channel = await this._fetchTextChannel(this.generalChannelId);
        await channel.send(text.slice(0, DISCORD_MAX_LENGTH));
      }
    }
  }

  /** Edit text and clear components (Discord keeps components on a plain edit,
   * so we must pass an empty array to drop the Cancel button). */
  async editMessageRemoveButtons(chatId: string, messageId: string, text: string, threadId?: string): Promise<void> {
    // Prefer the exact channel (handles forum-topic threads, which a GuildText
    // scan misses); fall back to scanning top-level text channels.
    try {
      const channel = await this._fetchTextChannel(threadId ?? chatId);
      const msg = await channel.messages.fetch(messageId);
      await msg.edit({ content: text.slice(0, DISCORD_MAX_LENGTH), components: [] });
      return;
    } catch { /* not in that channel — fall through to scan */ }
    try {
      const guild = await this.client.guilds.fetch(this.guildId);
      const channels = guild.channels.cache.filter((c) => c.type === ChannelType.GuildText);
      for (const [, ch] of channels) {
        try {
          const textCh = ch as TextChannel;
          const msg = await textCh.messages.fetch(messageId);
          await msg.edit({ content: text.slice(0, DISCORD_MAX_LENGTH), components: [] });
          return;
        } catch {
          continue;
        }
      }
    } catch { /* message gone — nothing to clear */ }
  }

  async deleteMessage(chatId: string, messageId: string, threadId?: string): Promise<void> {
    // Prefer the exact channel (handles forum-topic threads, which a GuildText
    // scan misses); fall back to scanning top-level text channels.
    try {
      const channel = await this._fetchTextChannel(threadId ?? chatId);
      const msg = await channel.messages.fetch(messageId);
      await msg.delete();
      return;
    } catch { /* not in that channel — fall through to scan */ }
    try {
      const guild = await this.client.guilds.fetch(this.guildId);
      const channels = guild.channels.cache.filter((c) => c.type === ChannelType.GuildText);
      for (const [, ch] of channels) {
        try {
          const textCh = ch as TextChannel;
          const msg = await textCh.messages.fetch(messageId);
          await msg.delete();
          return;
        } catch {
          continue;
        }
      }
    } catch { /* message already gone */ }
  }

  async react(chatId: string, messageId: string, emoji: string, threadId?: string): Promise<void> {
    try {
      // A Discord thread is its own channel — a message posted in a topic thread
      // lives there, not in the parent channel, so react on threadId when given.
      const channelId = threadId ?? chatId;
      // Direct REST call — single API request instead of 3 (fetchChannel → fetchMessage → react)
      const encoded = encodeURIComponent(emoji);
      await (this.client as any).rest.put(
        `/channels/${channelId}/messages/${messageId}/reactions/${encoded}/@me`
      );
    } catch {
      // No-op per degradation strategy
    }
  }

  // ── Approval ───────────────────────────────────────────────────────────

  async sendApproval(
    prompt: PermissionPrompt,
    callback: (decision: "approve" | "approve_always" | "deny") => void,
    signal?: AbortSignal,
    threadId?: string,
  ): Promise<ApprovalHandle> {
    const nonce = randomBytes(5).toString("hex");
    const approveData = `approval:approve:${nonce}`;
    const alwaysData = `approval:approve_always:${nonce}`;
    const denyData = `approval:deny:${nonce}`;

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(approveData)
        .setLabel("Allow")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(alwaysData)
        .setLabel("Always")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(denyData)
        .setLabel("Deny")
        .setStyle(ButtonStyle.Danger),
    );

    let text = `⚠️ **Permission Request**\nTool: \`${prompt.tool_name}\``;
    if (prompt.input_preview) {
      const preview = prompt.input_preview.length > 200
        ? prompt.input_preview.slice(0, 200) + "…"
        : prompt.input_preview;
      text += `\n\`\`\`\n${preview}\n\`\`\``;
    } else if (prompt.description) {
      text += `\n${prompt.description}`;
    }

    const cleanup = () => {
      this.off("callback_query", handler);
    };

    const handler = (query: { callbackData?: string; chatId?: string; threadId?: string; messageId?: string }) => {
      if (!query.callbackData) return;
      const isApprove = query.callbackData === approveData;
      const isAlways = query.callbackData === alwaysData;
      const isDeny = query.callbackData === denyData;
      if (!isApprove && !isAlways && !isDeny) return;

      cleanup();

      // Update the message to show the decision
      if (query.threadId && query.messageId) {
        this._fetchTextChannel(query.threadId).then((ch) => {
          ch.messages.fetch(query.messageId!).then((msg: Message) => {
            const label = isDeny ? "❌ Denied" : isAlways ? "✅ Always Allowed" : "✅ Allowed";
            msg.edit({
              content: `${label}\nTool: \`${prompt.tool_name}\``,
              components: [],
            }).catch(() => {});
          }).catch(() => {});
        }).catch(() => {});
      }

      callback(isDeny ? "deny" : isAlways ? "approve_always" : "approve");
    };

    this.on("callback_query", handler);

    if (signal) {
      signal.addEventListener("abort", () => cleanup());
    }

    const channelId = threadId ?? this.generalChannelId;
    if (channelId) {
      const channel = await this._fetchTextChannel(channelId);
      await channel.send({ content: text, components: [row] });
    } else {
      this.emit("approval_request", { prompt: text, components: [row], nonce });
    }

    return { cancel: cleanup };
  }

  // ── Chat ID management ──────────────────────────────────────────────────

  getChatId(): string | null { return this.lastChatId; }
  setChatId(chatId: string): void { this.lastChatId = chatId; }

  // ── File download ──────────────────────────────────────────────────────

  async downloadAttachment(fileId: string): Promise<string> {
    const url = this.attachmentUrls.get(fileId);
    if (!url) throw new Error(`No URL for attachment: ${fileId}`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Download failed: ${response.status}`);
    const filename = `${Date.now()}-${fileId.slice(-8)}-${url.split("/").pop()?.split("?")[0] ?? "file"}`;
    const localPath = join(this.inboxDir, filename);
    const dest = createWriteStream(localPath);
    const body = response.body;
    if (!body) throw new Error("No response body");
    await pipeline(Readable.fromWeb(body as import("stream/web").ReadableStream), dest);
    return localPath;
  }

  // ── Intent-oriented methods ──────────────────────────────────────────

  async promptUser(chatId: string, text: string, choices: Choice[], opts?: SendOpts): Promise<string> {
    const channelId = opts?.threadId ?? chatId;
    const channel = await this._fetchTextChannel(channelId);

    const row = new ActionRowBuilder<ButtonBuilder>();
    for (const choice of choices) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(choice.id)
          .setLabel(choice.label.slice(0, 80)) // Discord button label max 80 chars
          .setStyle(ButtonStyle.Primary),
      );
    }

    const msg = await channel.send({ content: text, components: [row] });
    return msg.id;
  }

  async notifyAlert(chatId: string, alert: AlertData, opts?: SendOpts): Promise<SentMessage> {
    if (alert.choices && alert.choices.length > 0) {
      const channelId = opts?.threadId ?? chatId;
      const channel = await this._fetchTextChannel(channelId);

      const row = new ActionRowBuilder<ButtonBuilder>();
      for (const choice of alert.choices) {
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(choice.id)
            .setLabel(choice.label.slice(0, 80))
            .setStyle(ButtonStyle.Secondary),
        );
      }

      const msg = await channel.send({ content: alert.message, components: [row] });
      return { messageId: msg.id, chatId, threadId: opts?.threadId };
    }
    return this.sendText(chatId, alert.message, opts);
  }

  // ── Topology: create channel ────────────────────────────────────────────

  private async _resolveCategory(): Promise<string> {
    const guild = await this.client.guilds.fetch(this.guildId);
    await guild.channels.fetch();
    const existing = guild.channels.cache.find(
      (c: { type: ChannelType; name: string }) => c.type === ChannelType.GuildCategory && c.name === this.categoryName,
    );
    if (existing) return existing.id;
    const cat = await guild.channels.create({
      name: this.categoryName,
      type: ChannelType.GuildCategory,
    });
    return cat.id;
  }

  private async ensureCategoryId(): Promise<string> {
    if (!this.categoryIdPromise) {
      this.categoryIdPromise = this._resolveCategory().catch((err) => {
        this.categoryIdPromise = undefined;
        throw err;
      });
    }
    return this.categoryIdPromise;
  }

  async createTopic(name: string): Promise<string> {
    const guild = await this.client.guilds.fetch(this.guildId);
    const categoryId = await this.ensureCategoryId();

    try {
      const channel = await guild.channels.create({
        name,
        type: ChannelType.GuildText,
        parent: categoryId,
      });
      return channel.id;
    } catch (err: unknown) {
      // 10003 = Unknown Channel — category was deleted externally
      if ((err as { code?: number }).code === 10003) {
        this.categoryIdPromise = undefined;
        const freshId = await this.ensureCategoryId();
        const channel = await guild.channels.create({
          name,
          type: ChannelType.GuildText,
          parent: freshId,
        });
        return channel.id;
      }
      throw err;
    }
  }

  async deleteTopic(topicId: number | string): Promise<void> {
    const channel = await this.client.channels.fetch(String(topicId));
    // Only delete GuildText channels created by createTopic — never categories or forums
    if (channel && "type" in channel && (channel as { type: ChannelType }).type === ChannelType.GuildText && "delete" in channel) {
      await (channel as { delete(): Promise<unknown> }).delete();
    }
  }

  async topicExists(topicId: number | string): Promise<boolean> {
    try {
      const channel = await this.client.channels.fetch(String(topicId));
      return channel != null;
    } catch {
      return false;
    }
  }

  // ── Pairing ────────────────────────────────────────────────────────────

  async handlePairing(chatId: string, userId: string): Promise<string> {
    const code = this.accessManager.generateCode(userId);
    return code;
  }

  async confirmPairing(code: string, callerUserId?: string): Promise<boolean> {
    return this.accessManager.confirmCode(code, callerUserId);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function splitText(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    chunks.push(text.slice(offset, offset + limit));
    offset += limit;
  }
  return chunks;
}
