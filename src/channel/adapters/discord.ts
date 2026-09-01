import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { t } from "../../locale.js";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { createWriteStream } from "node:fs";
import {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ApplicationCommandOptionType,
  ChannelType,
  MessageFlags,
  Status,
  type TextChannel,
  type Message,
  type MessageReaction,
  type PartialMessageReaction,
  type User,
  type PartialUser,
  type Interaction,
  type ChatInputCommandInteraction,
} from "discord.js";
import type {
  ChannelAdapter,
  ApprovalHandle,
  SendOpts,
  SentMessage,
  PermissionPrompt,
  Choice,
  AlertData,
  AdapterHealthSnapshot,
} from "../types.js";
import type { AccessManager } from "../access-manager.js";
import { MessageQueue } from "../message-queue.js";

const DISCORD_MAX_LENGTH = 2000;
const GATEWAY_WATCHDOG_INTERVAL_MS = 30_000;
const GATEWAY_STALE_MIN_MS = 180_000;
const GATEWAY_RECONNECT_WAIT_MS = 30_000;
const GATEWAY_MAX_BACKOFF_MS = 5 * 60_000;

/** Curated ClassicBot backends for Discord's native slash-option dropdown. */
export const DISCORD_START_BACKEND_CHOICES = [
  { name: "Claude Code", value: "claude-code" },
  { name: "Kiro CLI", value: "kiro-cli" },
  { name: "Codex", value: "codex" },
  { name: "OpenCode", value: "opencode" },
  { name: "Antigravity", value: "antigravity" },
  { name: "Grok Build", value: "grok" },
] as const;

const CLASSIC_START_BACKEND_SELECT_ID = "classic-start-backend";

export interface DiscordAdapterOptions {
  id: string;
  botToken: string;
  accessManager: AccessManager;
  inboxDir: string;
  guildId: string;
  categoryName?: string;
  generalChannelId?: string;
  registerCommands?: boolean;
  /** Test seams; production callers leave these unset. */
  clientFactory?: () => Client;
  now?: () => number;
  watchdogIntervalMs?: number;
  staleThresholdMs?: number;
  reconnectBaseDelayMs?: number;
}

export class DiscordAdapter extends EventEmitter implements ChannelAdapter {
  readonly type = "discord";
  readonly topology = "channels" as const;
  readonly id: string;

  private client: Client;
  private readonly clientFactory: () => Client;
  private readonly now: () => number;
  private readonly watchdogIntervalMs: number;
  private readonly staleThresholdMs: number;
  private readonly reconnectBaseDelayMs: number;
  private desiredRunning = false;
  private lifecycleEpoch = 0;
  private clientGeneration = 0;
  private reconnectPromise: Promise<void> | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private lastWatchdogTickAt = 0;
  private generationReadyAt = 0;
  private generationNonReadySince = 0;
  private shardNonReadySince = new Map<number, number>();
  private previousHeartbeatAck = new Map<number, number>();
  private observedHeartbeatInterval = new Map<number, number>();
  private healthStatus: AdapterHealthSnapshot["status"] = "stopped";
  private lastDispatchAt: number | null = null;
  private lastReconnectAt: number | null = null;
  private lastReconnectReason: string | null = null;
  private reconnectCount = 0;
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

    this.clientFactory = opts.clientFactory ?? (() => this.buildClient());
    this.now = opts.now ?? Date.now;
    this.watchdogIntervalMs = opts.watchdogIntervalMs ?? GATEWAY_WATCHDOG_INTERVAL_MS;
    this.staleThresholdMs = opts.staleThresholdMs ?? GATEWAY_STALE_MIN_MS;
    this.reconnectBaseDelayMs = opts.reconnectBaseDelayMs ?? 5_000;
    this.client = this.clientFactory();

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

    this.registerClientHandlers(this.client, this.clientGeneration);
  }

  private buildClient(): Client {
    return new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
      ],
      // Events for messages/reactions created before this process started are partial.
      partials: [Partials.Message, Partials.Reaction, Partials.User],
    });
  }

  private async _fetchTextChannel(channelId: string): Promise<TextChannel> {
    const client = await this.readyClient();
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased()) {
      throw new Error(`Channel ${channelId} is not a text channel`);
    }
    return channel as TextChannel;
  }

  private registerClientHandlers(client: Client, generation: number): void {
    // Client/shard errors (WebSocket hiccups, gateway resumes, etc.). discord.js
    // auto-reconnects; we just need a listener so Node's EventEmitter doesn't
    // rethrow on "error" — without one it surfaces as an uncaughtException and
    // the process-level handler tears down the whole fleet (the built-in adapter
    // shares the fleet process).
    client.on("error", (err) => {
      if (!this.isCurrentClient(client, generation)) return;
      console.warn(`[discord:${this.id}] client error: ${(err as Error)?.message ?? err}`);
      this.healthStatus = "retrying";
      this.emitHealthChanged();
    });
    client.on("shardError", (err, shardId) => {
      if (!this.isCurrentClient(client, generation)) return;
      console.warn(`[discord:${this.id}] shard ${shardId} error: ${(err as Error)?.message ?? err}`);
      this.healthStatus = "retrying";
      this.emitHealthChanged();
    });
    client.on("shardReconnecting", (shardId) => {
      if (!this.isCurrentClient(client, generation)) return;
      this.healthStatus = "retrying";
      console.warn(`[discord:${this.id}] shard ${shardId} reconnecting`);
    });
    client.on("shardResume", (shardId, replayedEvents) => {
      if (!this.isCurrentClient(client, generation)) return;
      this.healthStatus = "connected";
      this.shardNonReadySince.delete(shardId);
      console.info(`[discord:${this.id}] shard ${shardId} resumed (${replayedEvents} replayed event(s))`);
    });
    client.on("shardReady", (shardId) => {
      if (!this.isCurrentClient(client, generation)) return;
      this.healthStatus = "connected";
      this.shardNonReadySince.delete(shardId);
    });
    client.on("shardDisconnect", (event, shardId) => {
      if (!this.isCurrentClient(client, generation)) return;
      this.healthStatus = "retrying";
      this.shardNonReadySince.set(shardId, this.now());
      console.warn(`[discord:${this.id}] shard ${shardId} disconnected (${event.code}: ${event.reason || "no reason"})`);
    });
    client.on("invalidated", () => {
      if (!this.isCurrentClient(client, generation)) return;
      console.warn(`[discord:${this.id}] gateway session invalidated; rebuilding client`);
      void this.reconnectGateway("gateway session invalidated").catch(() => {});
    });
    client.on("raw", (packet) => {
      if (!this.isCurrentClient(client, generation)) return;
      if ((packet as { t?: unknown }).t) this.lastDispatchAt = this.now();
    });
    client.once("ready", () => void this.handleClientReady(client, generation));

    // Reactions on the bot's messages, as inbound events (#408). Both add and remove
    // are reported so an agent can see an approval being withdrawn.
    const onReaction = async (
      reaction: MessageReaction | PartialMessageReaction,
      user: User | PartialUser,
      action: "add" | "remove",
    ): Promise<void> => {
      try {
        // Partial reaction — the message is not in cache, which is every message
        // from before this process started. Fetch before reading .message.
        if (reaction.partial) {
          try { await reaction.fetch(); } catch { return; }
        }
        if (!this.isCurrentClient(client, generation)) return;
        if (user.id === client.user?.id) return; // our own reaction
        // Other bots' reactions are DELIVERED on purpose: agents react to each
        // other's messages as signals (agent A 👍 → agent B sees it). The noise
        // this used to guard against — sibling AgEnD bots stamping the
        // delivery-status ladder — is filtered downstream by exact emoji
        // (DELIVERY_STATUS_EMOJIS in fleet-manager), not by sender kind.
        const message = reaction.message;
        // Only reactions on OUR messages are meaningful as agent signals; a user
        // reacting to another user's message is chatter.
        if (message.author?.id && message.author.id !== client.user?.id) return;
        if (message.guildId && message.guildId !== this.guildId && !this.openChannels.has(message.channelId)) return;

        this.emitFromClient(client, generation, "reaction", {
          source: "discord",
          adapterId: this.id,
          chatId: this.guildId,
          threadId: message.channelId,
          messageId: message.id,
          userId: user.id,
          username: ("username" in user ? user.username : null) ?? user.id,
          emoji: reaction.emoji.name ?? reaction.emoji.toString(),
          action,
          timestamp: new Date(),
        });
      } catch (err) {
        // Same containment as the other handlers: a throw here would become an
        // unhandledRejection.
        console.warn(`[discord] reaction ${action} handler error (${(err as Error).message})`);
      }
    };
    client.on("messageReactionAdd", (reaction, user) => void onReaction(reaction, user, "add"));
    client.on("messageReactionRemove", (reaction, user) => void onReaction(reaction, user, "remove"));

    client.on("messageCreate", async (msg: Message) => {
      try {
      if (!this.isCurrentClient(client, generation)) return;
      if (msg.author.id === client.user?.id) return; // Ignore own messages
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

      // Handle forwarded messages (messageSnapshots) and embeds.
      //
      // NOT gated on empty content: a forward WITH a comment used to skip this
      // block entirely, silently dropping the forwarded text and images. The
      // forwarded payload matters regardless of whether the forwarder added
      // their own words.
      const forwardedParts: string[] = [];
      // Images that arrive as embeds rather than attachments — a forwarded
      // image is often re-materialized by Discord as an embed of type "image".
      // Only that type: "rich"/"link" (link previews) and "video"/"gifv" are
      // not images and must not be downloaded as such.
      const embedImageUrls: string[] = [];
      const collectImageEmbeds = (embeds: readonly any[] | undefined): void => {
        for (const e of embeds ?? []) {
          const type = e?.data?.type ?? e?.type;
          if (type !== "image") continue;
          const url = e?.url ?? e?.data?.url ?? e?.thumbnail?.url;
          if (typeof url === "string" && url && !embedImageUrls.includes(url)) {
            embedImageUrls.push(url);
          }
        }
      };

      const messageSnapshots = (msg as any).messageSnapshots;
      if (messageSnapshots?.size > 0) {
        // Keep this diagnostic structural only: forwarded content and signed CDN
        // URLs may be private. It is deliberately JSON so reports from differing
        // discord.js versions are directly comparable without logging payloads.
        console.debug(`[discord] forwarded payload structure: ${JSON.stringify({
          messageSnapshots: [...messageSnapshots.values()].map((value: any) => {
            const snapshot = value?.message ?? value;
            return {
              shape: value?.message ? "api-wrapper" : "discordjs-message",
              attachments: snapshot?.attachments?.size ?? snapshot?.attachments?.length ?? 0,
              embeds: snapshot?.embeds?.length ?? 0,
              embedTypes: (snapshot?.embeds ?? []).map((embed: any) => embed?.data?.type ?? embed?.type ?? null),
            };
          }),
          outerEmbeds: msg.embeds.map((embed: any) => embed?.data?.type ?? embed?.type ?? null),
        })}`);

        for (const [, value] of messageSnapshots) {
          // The Discord gateway API uses { message: APIMessageSnapshotFields },
          // but discord.js unwraps that layer while constructing Message and
          // stores MessageSnapshot values directly in messageSnapshots. Accept
          // the raw wrapper too for compatibility with hand-built integrations.
          const snapshot = value?.message ?? value;
          if (snapshot?.content) forwardedParts.push(snapshot.content);
          if (snapshot?.embeds?.length) {
            collectImageEmbeds(snapshot.embeds);
            for (const e of snapshot.embeds) {
              if (e.title) forwardedParts.push(e.title);
              if (e.description) forwardedParts.push(e.description);
            }
          }
          // Forward attachments (images, files) into the main message
          if (snapshot?.attachments?.size > 0) {
            for (const [, att] of snapshot.attachments) {
              msg.attachments.set(att.id, att);
            }
          }
        }
      }
      // Do not collect images from the outer message's embeds. Discord creates
      // those automatically for ordinary image URLs, and treating them as
      // attachments would download content the user only linked. Forwarded
      // images are collected exclusively from messageSnapshots above.

      if (forwardedParts.length > 0) {
        const forwarded = forwardedParts.join("\n");
        // A bare forward reads as the forwarded text itself (unchanged
        // behaviour); a forward with a comment keeps both, labelled.
        text = text ? `${text}\n[Forwarded]\n${forwarded}` : forwarded;
      } else if (!text && msg.embeds.length > 0) {
        // Rich embeds (links, bot messages, etc.)
        const parts: string[] = [];
        for (const e of msg.embeds) {
          if (e.title) parts.push(e.title);
          if (e.description) parts.push(e.description);
          if (e.fields?.length) {
            for (const f of e.fields) parts.push(`${f.name}: ${f.value}`);
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

      // A Discord reply carries only the referenced message id on the new
      // message. Fetch the original so image attachments are delivered with
      // the reply rather than reducing the reference to text alone. Keep this
      // limited to real attachments: ordinary URL auto-embeds must not become
      // downloads (the same policy as the outer message above).
      let replyToText: string | undefined;
      if (msg.reference?.messageId) {
        try {
          const ref = await msg.fetchReference();
          replyToText = ref.content || ref.embeds?.[0]?.description || undefined;
          for (const att of ref.attachments?.values() ?? []) {
            if (!att.contentType?.startsWith("image/")) continue;
            if (!attachments.some(existing => existing.fileId === att.id)) {
              attachments.push({
                kind: "photo",
                fileId: att.id,
                mime: att.contentType,
                size: att.size,
                filename: att.name ?? undefined,
              });
            }
            this.attachmentUrls.set(att.id, att.url);
          }
        } catch { /* deleted message or no permission */ }
      }

      // Embed images become synthetic photo attachments so the normal download
      // path (attachment-handler → downloadAttachment → image_path) serves them
      // without knowing where the bytes came from. Their synthetic ids are
      // registered in attachmentUrls exactly like real attachment ids.
      embedImageUrls.forEach((url, i) => {
        const base = url.split("/").pop()?.split("?")[0] ?? "image";
        const ext = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1).toLowerCase() : "";
        const fileId = `embed-img-${messageId}-${i}`;
        attachments.push({
          kind: "photo",
          fileId,
          mime: ext ? `image/${ext === "jpg" ? "jpeg" : ext}` : undefined,
          size: 0, // unknown — embeds carry no byte size
          filename: base,
        });
        this.attachmentUrls.set(fileId, url);
      });

      // Store attachment URLs for later download
      for (const att of msg.attachments.values()) {
        this.attachmentUrls.set(att.id, att.url);
      }
      while (this.attachmentUrls.size > 1000) {
        const first = this.attachmentUrls.keys().next().value;
        if (first) this.attachmentUrls.delete(first);
        else break;
      }

      this.emitFromClient(client, generation, "message", {
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
    client.on("interactionCreate", async (interaction: Interaction) => {
      try {
        if (!this.isCurrentClient(client, generation)) return;
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
          this.emitFromClient(client, generation, "callback_query", {
            callbackData: interaction.customId,
            chatId: this.guildId,
            threadId: interaction.channelId,
            messageId: interaction.message.id,
            userId: interaction.user.id,
          });
          return;
        }

        // Select menus use the selected option value as the callback payload.
        // Acknowledge before routing for the same 3-second constraint as buttons.
        if (interaction.isStringSelectMenu()) {
          try { await interaction.deferUpdate(); } catch { /* already acknowledged / unknown interaction */ }
          // `/start` is allowed in configured secondary guilds, but its channel
          // is not in openChannels until AFTER the selection creates a Classic
          // instance. Let this one coordinator-owned menu through; fleet-manager
          // still validates its nonce, channel and initiating user. Other select
          // menus retain the normal primary/open-channel boundary.
          if (interaction.customId !== CLASSIC_START_BACKEND_SELECT_ID
            && interaction.guildId !== this.guildId
            && !this.openChannels.has(interaction.channelId ?? "")) return;
          const callbackData = interaction.values[0];
          if (!callbackData) return;
          this.emitFromClient(client, generation, "callback_query", {
            callbackData,
            chatId: this.guildId,
            threadId: interaction.channelId,
            messageId: interaction.message.id,
            userId: interaction.user.id,
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
            this.emitFromClient(client, generation, "slash_command", {
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
            // /update progress must survive the fleet process restart. A public
            // bot message can be re-fetched and edited by the new process;
            // Discord ephemeral interaction replies cannot.
            await interaction.deferReply({ ephemeral: interaction.commandName !== "update" });
            // Extract options as key-value pairs for fleet-manager
            const options: Record<string, string | boolean> = {};
            for (const opt of interaction.options.data) {
              options[opt.name] = opt.value as string | boolean;
            }
            this.emitFromClient(client, generation, "slash_command", {
              command: interaction.commandName,
              channelId: interaction.channelId,
              channelName,
              guildId: interaction.guildId ?? undefined,
              userId: interaction.user.id,
              username,
              options,
              respond: async (reply: string) => { try { return await this._editReplyLong(interaction, reply); } catch { return undefined; } },
              dismissResponse: async () => {
                try { await interaction.deleteReply(); } catch { /* interaction may already be gone */ }
              },
              respondChoices: async (text: string, choices: Choice[]) => {
                const select = new StringSelectMenuBuilder()
                  .setCustomId(CLASSIC_START_BACKEND_SELECT_ID)
                  .setPlaceholder("Choose a backend")
                  .addOptions(choices.map(choice => ({
                    label: choice.label.slice(0, 100),
                    value: choice.id.slice(0, 100),
                  })));
                const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
                try {
                  const message = await interaction.editReply({ content: text, components: [row] });
                  return message.id;
                } catch {
                  return undefined;
                }
              },
            });
          }
        }
      } catch (err) {
        console.warn(`[discord] interactionCreate error (${(err as Error).message})`);
      }
    });

    // Handle channel deletion (equivalent to topic_closed)
    client.on("guildCreate", (guild) => {
      if (!this.isCurrentClient(client, generation)) return;
      this.emitFromClient(client, generation, "new_group_detected", {
        groupId: guild.id,
        groupTitle: guild.name,
        source: "discord",
      });
    });

    client.on("channelDelete", (channel) => {
      if (!this.isCurrentClient(client, generation)) return;
      if (!("guildId" in channel)) return;
      if (channel.guildId !== this.guildId) {
        if (!this.openChannels.has(channel.id)) return;
        // Allowed: an open classic channel in a non-primary guild was deleted.
      }
      this.emitFromClient(client, generation, "topic_closed", {
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

  private isCurrentClient(client: Client, generation: number): boolean {
    // lifecycleEpoch===0 preserves constructor-level handler tests; a real Client
    // cannot dispatch gateway events before start/login.
    return (this.desiredRunning || this.lifecycleEpoch === 0)
      && this.client === client
      && this.clientGeneration === generation;
  }

  private emitFromClient(client: Client, generation: number, event: string, ...args: unknown[]): boolean {
    return this.isCurrentClient(client, generation) ? this.emit(event, ...args) : false;
  }

  private emitHealthChanged(): void {
    this.emit("gateway_health", this.getHealthSnapshot());
  }

  private async loginFreshClient(reason: string, epoch: number): Promise<void> {
    const oldClient = this.client;
    // A destroyed discord.js Client cannot be logged in again. Destroy first to
    // avoid overlapping gateway sessions delivering MESSAGE_CREATE twice.
    oldClient.destroy();

    const client = this.clientFactory();
    const generation = ++this.clientGeneration;
    this.client = client;
    this.generationReadyAt = 0;
    this.generationNonReadySince = this.now();
    this.shardNonReadySince.clear();
    this.previousHeartbeatAck.clear();
    this.observedHeartbeatInterval.clear();
    this.registerClientHandlers(client, generation);
    this.emitHealthChanged();
    try {
      await client.login(this.botToken);
      if (!this.desiredRunning || epoch !== this.lifecycleEpoch || this.client !== client) {
        client.destroy();
        throw new Error("Discord gateway login superseded by lifecycle change");
      }
      this.lastReconnectAt = this.now();
      this.lastReconnectReason = reason;
      this.healthStatus = client.isReady() ? "connected" : "starting";
      this.emitHealthChanged();
    } catch (err) {
      client.destroy();
      throw err;
    }
  }

  /** Rebuild just this bot's gateway Client. Calls coalesce into one generation. */
  reconnectGateway(reason: string): Promise<void> {
    if (this.reconnectPromise) return this.reconnectPromise;
    if (!this.desiredRunning) return Promise.reject(new Error("Discord adapter is stopped"));
    const epoch = this.lifecycleEpoch;
    const reconnect = (async () => {
      // Yield once so reconnectPromise is installed before destroy/login can emit
      // a synchronous gateway error and re-enter this method.
      await Promise.resolve();
      if (!this.desiredRunning || epoch !== this.lifecycleEpoch) {
        throw new Error("Discord gateway reconnect cancelled by adapter stop");
      }
      this.healthStatus = "retrying";
      this.lastReconnectReason = reason;
      this.reconnectCount++;
      this.emitHealthChanged();
      for (let attempt = 0; this.desiredRunning && epoch === this.lifecycleEpoch; attempt++) {
        if (attempt > 0) {
          const delay = Math.min(this.reconnectBaseDelayMs * 2 ** Math.min(attempt - 1, 6), GATEWAY_MAX_BACKOFF_MS);
          await new Promise<void>(resolve => {
            const timer = setTimeout(resolve, delay);
            timer.unref?.();
          });
          if (!this.desiredRunning || epoch !== this.lifecycleEpoch) break;
        }
        try {
          await this.loginFreshClient(reason, epoch);
          if (this.desiredRunning && epoch === this.lifecycleEpoch) {
            this.healthStatus = "connected";
            this.emitHealthChanged();
          }
          return;
        } catch (err) {
          if (!this.desiredRunning || epoch !== this.lifecycleEpoch) break;
          this.healthStatus = "retrying";
          console.warn(`[discord:${this.id}] gateway rebuild attempt ${attempt + 1} failed: ${(err as Error).message}`);
          this.emitHealthChanged();
        }
      }
      throw new Error("Discord gateway reconnect cancelled by adapter stop");
    })().finally(() => {
      if (this.reconnectPromise === reconnect) this.reconnectPromise = null;
    });
    this.reconnectPromise = reconnect;
    return reconnect;
  }

  private async readyClient(): Promise<Client> {
    // A few focused unit tests install a minimal REST-only client stand-in. Real
    // discord.js Clients always expose isReady().
    const isReady = typeof (this.client as any).isReady === "function"
      ? this.client.isReady()
      : true;
    if (isReady && !this.reconnectPromise) return this.client;
    const reconnect = this.reconnectPromise ?? this.reconnectGateway("outbound requested while gateway unavailable");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        reconnect,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Discord gateway reconnect timed out")), GATEWAY_RECONNECT_WAIT_MS);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!this.client.isReady()) throw new Error("Discord gateway is not ready");
    return this.client;
  }

  private startGatewayWatchdog(): void {
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.lastWatchdogTickAt = this.now();
    this.watchdogTimer = setInterval(() => this.checkGatewayLiveness(), this.watchdogIntervalMs);
    this.watchdogTimer.unref?.();
  }

  private checkGatewayLiveness(): void {
    if (!this.desiredRunning || this.reconnectPromise) return;
    const now = this.now();
    const elapsed = now - this.lastWatchdogTickAt;
    this.lastWatchdogTickAt = now;
    // Host suspend / an overloaded event loop makes wall-clock ACK age jump. Give
    // discord.js a fresh heartbeat window instead of rebuilding immediately.
    if (elapsed > this.watchdogIntervalMs * 3) {
      this.generationReadyAt = now;
      this.generationNonReadySince = now;
      this.shardNonReadySince.clear();
      return;
    }

    const shards = [...this.client.ws.shards.values()] as Array<{
      id: number;
      status: number;
      lastPingTimestamp: number;
    }>;
    let staleReason: string | null = null;
    if (!this.client.isReady() && this.generationNonReadySince === 0) this.generationNonReadySince = now;
    if (this.client.isReady()) this.generationNonReadySince = 0;
    if (!this.client.isReady() && now - this.generationNonReadySince > this.staleThresholdMs) {
      staleReason = `client non-ready for ${now - this.generationNonReadySince}ms`;
    }

    for (const shard of shards) {
      const lastAck = shard.lastPingTimestamp;
      const previous = this.previousHeartbeatAck.get(shard.id);
      if (lastAck >= 0 && previous != null && lastAck > previous) {
        const interval = lastAck - previous;
        if (interval >= 5_000 && interval <= 120_000) this.observedHeartbeatInterval.set(shard.id, interval);
      }
      if (lastAck >= 0) this.previousHeartbeatAck.set(shard.id, lastAck);
      const threshold = Math.max(this.staleThresholdMs, 3 * (this.observedHeartbeatInterval.get(shard.id) ?? 0));
      if (shard.status === Status.Ready) {
        this.shardNonReadySince.delete(shard.id);
        if (lastAck === -1) {
          if (this.generationReadyAt > 0 && now - this.generationReadyAt > threshold) {
            staleReason = `shard ${shard.id} has no heartbeat ACK after startup grace`;
          }
        } else if (now - lastAck > threshold) {
          staleReason = `shard ${shard.id} heartbeat ACK stale by ${now - lastAck}ms`;
        }
      } else {
        const since = this.shardNonReadySince.get(shard.id) ?? now;
        this.shardNonReadySince.set(shard.id, since);
        if (now - since > threshold) staleReason = `shard ${shard.id} status ${shard.status} for ${now - since}ms`;
      }
    }

    if (staleReason) {
      this.healthStatus = "stale";
      this.emitHealthChanged();
      console.warn(`[discord:${this.id}] gateway watchdog detected ${staleReason}`);
      void this.reconnectGateway(`watchdog: ${staleReason}`).catch(() => {});
    } else if (this.client.isReady()
      && shards.every(shard => shard.status === Status.Ready)
      && this.healthStatus !== "connected") {
      // discord.js owns the first recovery layer (RESUME + replay). Clear a
      // transient error marker once ACK/status prove that native recovery won.
      this.healthStatus = "connected";
      this.emitHealthChanged();
    }
  }

  getHealthSnapshot(): AdapterHealthSnapshot {
    const now = this.now();
    const shards = [...this.client.ws.shards.values()].map(shard => {
      const lastAck = shard.lastPingTimestamp >= 0 ? shard.lastPingTimestamp : null;
      return {
        id: shard.id,
        status: shard.status,
        lastHeartbeatAckAt: lastAck,
        heartbeatAgeMs: lastAck == null ? null : Math.max(0, now - lastAck),
      };
    });
    const heartbeatAcks = shards
      .map(shard => shard.lastHeartbeatAckAt)
      .filter((value): value is number => value != null);
    const lastHeartbeatAckAt = heartbeatAcks.length > 0 ? Math.min(...heartbeatAcks) : null;
    return {
      id: this.id,
      type: this.type,
      status: this.healthStatus,
      generation: this.clientGeneration,
      isReady: this.client.isReady(),
      wsStatus: this.client.ws.status ?? null,
      lastHeartbeatAckAt,
      heartbeatAgeMs: lastHeartbeatAckAt == null ? null : Math.max(0, now - lastHeartbeatAckAt),
      shards,
      lastDispatchAt: this.lastDispatchAt,
      lastReconnectAt: this.lastReconnectAt,
      lastReconnectReason: this.lastReconnectReason,
      reconnectCount: this.reconnectCount,
    };
  }

  private async handleClientReady(client: Client, generation: number): Promise<void> {
    if (!this.isCurrentClient(client, generation)) return;
    this.healthStatus = "connected";
    this.generationReadyAt = this.now();
    this.generationNonReadySince = 0;
    this.shardNonReadySince.clear();
    try {
      // Register classic bot slash commands (skipped for a secondary bot sharing
      // a guild with the primary — only the primary owns the guild's commands).
      if (this.registerCommands) try {
        await client.application?.commands.set([
          {
            name: "start", description: t("slash.start"),
            options: [{
              name: "backend",
              description: t("slash.option.backend"),
              type: ApplicationCommandOptionType.String,
              required: true,
              choices: DISCORD_START_BACKEND_CHOICES,
            }],
          },
          { name: "stop", description: t("slash.stop") },
          {
            name: "pause", description: "🔒 " + t("slash.pause"),
            options: [{ name: "instance", description: t("slash.option.instance"), type: ApplicationCommandOptionType.String, required: false }],
          },
          {
            name: "wake", description: "🔒 " + t("slash.wake"),
            options: [{ name: "instance", description: t("slash.option.instance"), type: ApplicationCommandOptionType.String, required: false }],
          },
          {
            name: "chat", description: t("slash.chat"),
            options: [{ name: "message", description: t("slash.option.message"), type: 3, required: true }],
          },
          { name: "status", description: "🔒 " + t("slash.status") },
          { name: "sysinfo", description: t("slash.sysinfo") },
          { name: "dashboard", description: t("slash.dashboard") },
          { name: "ctx", description: t("slash.ctx") },
          { name: "restart", description: "🔒 " + t("slash.restart") },
          { name: "update", description: "🔒 " + t("slash.update") },
          { name: "doctor", description: "🔒 " + t("slash.doctor") },
          { name: "usage", description: t("slash.usage") },
          {
            name: "tips", description: t("slash.tips"),
            options: [{
              name: "mode", description: t("slash.option.tips_mode"),
              type: ApplicationCommandOptionType.String, required: false,
              choices: [
                { name: "on", value: "on" },
                { name: "off", value: "off" },
                { name: "advanced on", value: "advanced on" },
              ],
            }],
          },
          { name: "compact", description: "🔒 " + t("slash.compact") },
          {
            name: "steer", description: t("slash.steer"),
            options: [{
              name: "message", description: t("slash.option.steer_message"),
              type: ApplicationCommandOptionType.String, required: true,
            }],
          },
          {
            name: "btw", description: t("slash.btw"),
            options: [{
              name: "message", description: t("slash.option.btw_message"),
              type: ApplicationCommandOptionType.String, required: true,
            }],
          },
          {
            name: "login", description: "🔒 " + t("slash.login"),
            options: [
              {
                name: "backend", description: t("slash.option.login_backend"),
                type: ApplicationCommandOptionType.String, required: false,
                choices: [
                  { name: "claude-code", value: "claude-code" },
                  { name: "codex", value: "codex" },
                  { name: "kiro-cli", value: "kiro-cli" },
                  { name: "grok", value: "grok" },
                  { name: "antigravity", value: "antigravity" },
                ],
              },
              { name: "code", description: t("slash.option.login_code"), type: ApplicationCommandOptionType.String, required: false },
              { name: "cancel", description: t("slash.option.login_cancel"), type: ApplicationCommandOptionType.Boolean, required: false },
            ],
          },
          {
            name: "install-cli", description: "🔒 " + t("slash.install_cli"),
            options: [
              {
                name: "backend", description: t("slash.option.install_backend"),
                type: ApplicationCommandOptionType.String, required: false,
                choices: [
                  { name: "claude-code", value: "claude-code" },
                  { name: "codex", value: "codex" },
                  { name: "kiro-cli", value: "kiro-cli" },
                  { name: "grok", value: "grok" },
                  { name: "antigravity", value: "antigravity" },
                  { name: "opencode", value: "opencode" },
                ],
              },
              { name: "cancel", description: t("slash.option.install_cancel"), type: ApplicationCommandOptionType.Boolean, required: false },
            ],
          },
          { name: "clear", description: "🔒 " + t("slash.clear") },
          {
            name: "model", description: "🔒 " + t("slash.model"),
          },
          {
            name: "effort", description: "🔒 " + t("slash.effort"),
            options: [{
              name: "level", description: t("slash.option.effort_level"),
              type: ApplicationCommandOptionType.String, required: false,
              choices: [
                { name: "low", value: "low" }, { name: "medium", value: "medium" },
                { name: "high", value: "high" }, { name: "xhigh", value: "xhigh" },
                { name: "max", value: "max" },
              ],
            }],
          },
          { name: "collab", description: "🔒 " + t("slash.collab") },
          {
            name: "save", description: "🔒 " + t("slash.save"),
            options: [
              { name: "filename", description: t("slash.option.save_filename"), type: 3, required: true },
              { name: "force", description: t("slash.option.save_force"), type: 5, required: false },
            ],
          },
          {
            name: "load", description: "🔒 " + t("slash.load"),
            options: [{ name: "filename", description: t("slash.option.load_filename"), type: 3, required: true }],
          },
          { name: "cancel", description: t("slash.cancel") },
        ]);
      } catch (err) {
        // Non-fatal — slash commands may fail on network issues
      }
      if (!this.isCurrentClient(client, generation)) return;
      this.emit("started", client.user?.username ?? "discord-bot", client.user?.id);
    } catch (err) {
      console.warn(`[discord:${this.id}] ready handler failed: ${(err as Error).message}`);
    }
  }

  async start(): Promise<void> {
    if (this.desiredRunning && this.client.isReady()) return;
    this.desiredRunning = true;
    const epoch = ++this.lifecycleEpoch;
    this.healthStatus = "starting";
    this.queue.start();
    try {
      await this.loginFreshClient("startup", epoch);
      this.startGatewayWatchdog();
    } catch (err) {
      if (epoch === this.lifecycleEpoch) {
        this.desiredRunning = false;
        this.healthStatus = "stopped";
      }
      throw err;
    }
  }

  async stop(): Promise<void> {
    this.desiredRunning = false;
    this.lifecycleEpoch++;
    this.healthStatus = "stopped";
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.watchdogTimer = null;
    this.queue.stop();
    this.client.destroy();
  }

  // ── Text / file sending ────────────────────────────────────────────────

  /**
   * Edit a deferred slash-command reply, handling text over Discord's 2000-char
   * message limit. A large fleet's /status or /sysinfo table exceeds it, and a
   * plain editReply would throw (DiscordAPIError) — leaving the ephemeral reply
   * stuck on "thinking". Short text stays a plain message (keeps the monospace
   * table readable); long text goes into embed(s) whose description allows 4096
   * chars, with followUp embeds for anything beyond that.
   */
  private async _editReplyLong(interaction: ChatInputCommandInteraction, reply: string): Promise<string | undefined> {
    const EMBED_MAX = 4096;
    if (reply.length <= DISCORD_MAX_LENGTH) {
      const message = await interaction.editReply({ content: reply, components: [] });
      return message.id;
    }
    const chunks = splitText(reply, EMBED_MAX);
    const message = await interaction.editReply({ content: "", embeds: [{ description: chunks[0] }], components: [] });
    for (let i = 1; i < chunks.length; i++) {
      await interaction.followUp({ ephemeral: true, embeds: [{ description: chunks[i] }] });
    }
    return message.id;
  }

  async sendText(chatId: string, text: string, opts?: SendOpts): Promise<SentMessage> {
    const channelId = opts?.threadId ?? chatId;
    const channel = await this._fetchTextChannel(channelId);
    const chunkLimit = opts?.chunkLimit ?? DISCORD_MAX_LENGTH;

    const chunks = splitText(text, chunkLimit);
    if (chunks.length === 0) throw new Error("Empty text");

    // Await every platform POST before reporting success. Previously only the
    // first chunk was awaited and later chunks were fire-and-forget queue items,
    // so the reply tool could return success for a silently truncated message.
    let first: Awaited<ReturnType<typeof channel.send>> | undefined;
    for (const chunk of chunks) {
      const sent = await channel.send(opts?.disablePreview
        ? { content: chunk, flags: MessageFlags.SuppressEmbeds }
        : chunk);
      first ??= sent;
    }

    return {
      messageId: first!.id,
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
      const guild = await (await this.readyClient()).guilds.fetch(this.guildId);
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
      // Do not turn an edit failure into a new send. A timeout can happen
      // after Discord applied the edit, and retrying as a fresh message would
      // duplicate the status/reply with no way to identify the accepted copy.
      console.warn(
        `[discord] editMessage failed; refusing new-message fallback because delivery outcome may be unknown: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** Edit text and clear components (Discord keeps components on a plain edit,
   * so we must pass an empty array to drop the Cancel button). */
  /** Keyboard-only removal — Discord keeps the original content untouched. */
  async removeMessageButtons(chatId: string, messageId: string, threadId?: string): Promise<void> {
    const channel = await this._fetchTextChannel(threadId ?? chatId);
    const msg = await channel.messages.fetch(messageId);
    await msg.edit({ components: [] });
  }

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
      const guild = await (await this.readyClient()).guilds.fetch(this.guildId);
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
      const guild = await (await this.readyClient()).guilds.fetch(this.guildId);
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
    // A Discord thread is its own channel — a message posted in a topic thread
    // lives there, not in the parent channel, so react on threadId when given.
    const channelId = threadId ?? chatId;
    const encoded = encodeURIComponent(emoji);
    try {
      // Direct REST call — single API request instead of 3 (fetchChannel → fetchMessage → react)
      await ((await this.readyClient()) as any).rest.put(
        `/channels/${channelId}/messages/${messageId}/reactions/${encoded}/@me`
      );
      return;
    } catch (directError) {
      // Reaction PUT is idempotent: retrying cannot create a duplicate. The
      // high-level discord.js path also normalizes custom emoji and refreshes
      // stale channel/message state, so it is a useful recovery path rather than
      // merely repeating the same request. Do not swallow both failures — the
      // MCP react tool must not return "ok" for a reaction nobody can see.
      try {
        const channel = await this._fetchTextChannel(channelId);
        const message = await channel.messages.fetch(messageId);
        await message.react(emoji);
        return;
      } catch (fallbackError) {
        throw new Error(
          `Discord reaction failed: ${(fallbackError as Error).message}`,
          { cause: directError },
        );
      }
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

    const select = new StringSelectMenuBuilder()
      .setCustomId(`prompt-${randomBytes(6).toString("hex")}`)
      .setPlaceholder("Choose an option")
      .addOptions(choices.map(choice => ({
        label: choice.label.slice(0, 100),
        value: choice.id.slice(0, 100),
      })));
    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);

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

  /**
   * Edit an alert's text while keeping its buttons.
   *
   * The two platforms disagree about what *omitting* the buttons means, and the
   * disagreement is exactly inverted:
   *
   *   Telegram — omitting `reply_markup` CLEARS the keyboard.
   *   Discord  — omitting `components` KEEPS whatever is already there.
   *
   * So an `editAlert` with no choices used to clear the buttons on one platform and
   * preserve them on the other, from the same call site. `components` is therefore
   * always sent, empty array included: `alert.choices` is the single description of
   * what the message should end up with, on both platforms.
   */
  async editAlert(chatId: string, messageId: string, alert: AlertData, opts?: SendOpts): Promise<void> {
    const channel = await this._fetchTextChannel(opts?.threadId ?? chatId);
    const msg = await channel.messages.fetch(messageId);
    const row = new ActionRowBuilder<ButtonBuilder>();
    for (const choice of alert.choices ?? []) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(choice.id)
          .setLabel(choice.label.slice(0, 80))
          .setStyle(ButtonStyle.Secondary),
      );
    }
    await msg.edit({
      content: alert.message.slice(0, DISCORD_MAX_LENGTH),
      components: row.components.length > 0 ? [row] : [],
    });
  }

  // ── Topology: create channel ────────────────────────────────────────────

  private async _resolveCategory(): Promise<string> {
    const guild = await (await this.readyClient()).guilds.fetch(this.guildId);
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
    const guild = await (await this.readyClient()).guilds.fetch(this.guildId);
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
    const channel = await (await this.readyClient()).channels.fetch(String(topicId));
    // Only delete GuildText channels created by createTopic — never categories or forums
    if (channel && "type" in channel && (channel as { type: ChannelType }).type === ChannelType.GuildText && "delete" in channel) {
      await (channel as { delete(): Promise<unknown> }).delete();
    }
  }

  async topicExists(topicId: number | string): Promise<boolean> {
    try {
      const channel = await (await this.readyClient()).channels.fetch(String(topicId));
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
