import { EventEmitter } from "node:events";
import type { PollRender } from "../reply-polls.js";

export interface Choice {
  id: string;
  label: string;
}

export interface InstanceStatusData {
  name: string;
  status: "running" | "stopped" | "crashed" | "paused";
  contextPct: number | null;
  costCents: number;
}

export interface AlertData {
  type: "hang" | "cost_warn" | "cost_limit" | "schedule_deferred" | "rotation" | "cancel" | "interactive_prompt" | "exit_restart" | "clear_confirm" | "tip" | "login" | "install" | "classic_approve" | "needs_you";
  instanceName: string;
  message: string;
  choices?: Choice[];
}

export type AdapterHealthStatus = "connected" | "starting" | "retrying" | "stale" | "stopped";

export interface AdapterShardHealth {
  id: number;
  status: number;
  lastHeartbeatAckAt: number | null;
  heartbeatAgeMs: number | null;
}

/** Serializable adapter health. Secrets and provider client objects must never appear here. */
export interface AdapterHealthSnapshot {
  id: string;
  type: string;
  status: AdapterHealthStatus;
  generation: number;
  isReady: boolean;
  wsStatus: number | null;
  /** Oldest shard ACK, so a single stale shard remains visible in the aggregate. */
  lastHeartbeatAckAt: number | null;
  heartbeatAgeMs: number | null;
  shards: AdapterShardHealth[];
  lastDispatchAt: number | null;
  lastReconnectAt: number | null;
  lastReconnectReason: string | null;
  reconnectCount: number;
}

/** Positive provider-side evidence used by the Settings connection rebind flow. */
export interface BindingProbe {
  group_id: string;
  group_name?: string | null;
  channel_id?: string | null;
  channel_name?: string | null;
  can_view: boolean;
  can_send: boolean;
  can_manage_topics?: boolean;
}

/**
 * Result of an adapter topology probe.
 *
 * `missing` is destructive-grade evidence: adapters may return it only when
 * the provider positively says the topic does not exist. Transport failures,
 * an empty cache, an unavailable gateway, and ambiguous permission errors are
 * all `unknown`.
 */
export type TopicMissingEvidence = "discord-unknown-channel" | "telegram-topic-not-found";

export type TopicProbePolicy = "periodic" | "on-demand";

export type TopicPresence =
  | { status: "present"; generation?: number }
  | { status: "missing"; generation?: number; evidence: TopicMissingEvidence }
  | { status: "unknown"; generation?: number; reason: string; detail?: string };

export interface ChannelAdapter extends EventEmitter {
  readonly type: string;
  readonly id: string;
  /** Authenticated platform identity, cache-only; absent until login/init. */
  getBotUserId?(): string | undefined;
  /** #1682: names for Discord mention ids from this adapter's own caches (never a request). */
  mentionNames?(query: { u: string[]; r: string[]; c: string[] }): { u?: Record<string, string>; r?: Record<string, string>; c?: Record<string, string> };

  start(): Promise<void>;
  stop(): Promise<void>;
  /** Hot-rebuild an adapter transport without discarding its outbound queue. */
  reconnectGateway?(reason: string): Promise<void>;
  /** Optional provider-specific liveness details consumed by /health and doctor. */
  getHealthSnapshot?(): AdapterHealthSnapshot;
  /** Verify a prospective group/guild binding without mutating this adapter. */
  verifyBinding?(groupId: string, generalChannelId?: string): Promise<BindingProbe>;
  /**
   * Set the provider's live activity/presence text when the platform supports
   * it (currently Discord only).  Adapters without a presence concept simply
   * leave this unset; callers must treat a false return as a best-effort skip.
   */
  setActivity?(text: string): boolean;
  /**
   * #1990: a group's public @username (Telegram), as last read; undefined when it has none or it has not been read
   * yet. Never waits on the network: a missing or stale value starts one bounded background read (getChat).
   */
  groupUsername?(groupId: string): string | undefined;
  /**
   * #1990: whether a user is a member of a group/guild — asked before a DM links into it. Read-only, with the fleet's
   * own bot token; rejects on any platform error (the caller then treats the user as not a member).
   */
  isGroupMember?(groupId: string, userId: string): Promise<boolean>;
  /**
   * #1920 §3.2: whether a user can see this channel (a Discord ClassicBot room): a member of its guild with View
   * Channel there. False when they are not (left the guild, or no view permission); rejects on any other platform
   * error (the caller then has no answer).
   */
  canViewChannel?(channelId: string, userId: string): Promise<boolean>;

  sendText(chatId: string, text: string, opts?: SendOpts): Promise<SentMessage>;
  /**
   * Deliver a message to ONE user privately (Discord DM, Telegram private
   * chat). Used for secrets that must never appear in a channel (the web
   * terminal access token). Rejects when the platform refuses (DMs disabled,
   * user never talked to the bot) — callers must not fall back to the channel.
   */
  sendDirect?(userId: string, text: string, opts?: SendOpts): Promise<SentMessage>;
  sendFile(chatId: string, filePath: string, opts?: SendOpts): Promise<SentMessage>;
  /** threadId locates the message when it lives in a topic/thread (Discord forum
   * topics are their own channel and won't be found by a guild text-channel scan). */
  /** #1651: "html" is the platform's parse mode, as on sendText; "markdown" is an agent's markdown (Telegram converts it
   * escape-first to HTML). Discord always renders Markdown. */
  editMessage(chatId: string, messageId: string, text: string, threadId?: string, opts?: { format?: "html" | "markdown" }): Promise<void>;
  /** Edit a message's text AND remove any inline buttons/components. Used to
   * retire a Cancel button after the agent replies or a timeout elapses.
   * threadId locates the message when it lives in a topic/thread (Discord
   * forum topics are their own channel and won't be found by a guild scan). */
  editMessageRemoveButtons?(chatId: string, messageId: string, text: string, threadId?: string, urlButtons?: Array<{ label: string; url: string }>): Promise<void>;
  /** Remove a message's buttons while keeping its text untouched. */
  removeMessageButtons?(chatId: string, messageId: string, threadId?: string): Promise<void>;
  /** #1610: replace a message's buttons, keeping its text untouched (a confirm step on a message whose text matters). */
  replaceMessageButtons?(chatId: string, messageId: string, choices: Choice[], threadId?: string): Promise<void>;
  /** #1266: this adapter puts `SendOpts.replyButtons` on the message it sends. */
  readonly supportsReplyButtons?: boolean;
  /** #1266: show a reply's buttons as ended — the choice and who made it, or expired — on the message carrying them. */
  settleReplyButtons?(chatId: string, messageId: string, threadId: string | undefined, labels: readonly string[], outcome: ReplyButtonsOutcome): Promise<void>;
  /** #1823: this adapter shows a poll (`SendOpts.replyPoll`) and redraws it (`renderPoll`). */
  readonly supportsPolls?: boolean;
  /** #1823: redraw a poll's buttons and status (its options, "N answered", the countdown; at close, the tally). */
  renderPoll?(chatId: string, messageId: string, threadId: string | undefined, poll: PollRender): Promise<void>;
  /** #1823: the least time between two poll redraws in one chat, inside the platform's edit limits. */
  readonly pollEditIntervalMs?: number;
  /**
   * #1823: what `pollEditIntervalMs` is counted over: "chat" (Telegram: a group's edit limit covers all its topics) or
   * the default, each thread (Discord: every channel and thread has its own bucket).
   */
  readonly pollRateScope?: "chat" | "thread";
  /** #1823: the platform cannot count down by itself: the status is redrawn as time passes (`pollTickMs`). */
  readonly pollCountdownTicks?: boolean;
  /** Delete a message (e.g. retire the Cancel button message when done).
   * threadId locates the message when it lives in a topic/thread. */
  deleteMessage?(chatId: string, messageId: string, threadId?: string): Promise<void>;
  /** React to a message. threadId locates a message in a topic/thread (Discord
   * threads are their own channel; Telegram reactions key on the supergroup
   * chat_id and ignore it). */
  react(chatId: string, messageId: string, emoji: string, threadId?: string): Promise<void>;
  /** Remove the bot's own reaction from a message. Optional so third-party
   * adapters keep working — callers fall back to a plain add when absent.
   * threadId follows the same routing rule as react. */
  unreact?(chatId: string, messageId: string, emoji: string, threadId?: string): Promise<void>;

  sendApproval(
    prompt: PermissionPrompt,
    callback: (decision: "approve" | "approve_always" | "deny") => void,
    signal?: AbortSignal,
    threadId?: string,
  ): Promise<ApprovalHandle>;

  downloadAttachment(fileId: string): Promise<string>;
  /**
   * Stickers this bot can send (#1226). Discord: the stickers of the server the
   * given channel belongs to — a bot cannot send another server's. Telegram:
   * the stickers of one sticker set, named by `set`. Optional: an adapter
   * without stickers leaves it out.
   */
  listStickers?(target: StickerTarget): Promise<StickerList>;
  /**
   * One sticker's picture, downloaded server-side (the Telegram file URL holds
   * the bot token). null when there is no still picture to show — a Discord
   * Lottie sticker, or an animated Telegram sticker without a thumbnail.
   */
  fetchStickerPreview?(sticker: StickerInfo): Promise<StickerPreview | null>;
  /**
   * #1630: this bot's own avatar, downloaded here (a Telegram file URL carries the token, which must not leave the
   * adapter). null when the bot has none set — a platform default says nothing about which bot it is.
   */
  fetchBotAvatar?(): Promise<StickerPreview | null>;
  /** #1630: this bot's colour (its highest coloured role) in the server `channelId` belongs to, or null for none. */
  botAccentColor?(channelId?: string): Promise<string | null>;
  /**
   * Send stickers, after `text` when there is any (#1226). Discord: on the same
   * message as the text's last chunk (`sticker_ids`); Telegram: the text, then
   * one sendSticker per sticker, in order. Every send is awaited — a sticker
   * that fails is an error, never silently dropped.
   */
  sendStickers?(chatId: string, stickers: string[], opts?: SendOpts & { text?: string }): Promise<SentMessage>;

  handlePairing(chatId: string, userId: string): Promise<string>;
  confirmPairing(code: string, callerUserId?: string): Promise<boolean>;

  readonly topology: "topics" | "channels" | "flat";

  setChatId(chatId: string): void;
  getChatId(): string | null;

  promptUser(chatId: string, text: string, choices: Choice[], opts?: SendOpts): Promise<string>;
  notifyAlert(chatId: string, alert: AlertData, opts?: SendOpts): Promise<SentMessage>;

  /**
   * Update an alert's text **in place, keeping its buttons**.
   *
   * Needed because `editMessage` cannot be reused here: on Telegram it calls
   * `editMessageText` without `reply_markup`, and omitting that field CLEARS the
   * inline keyboard (see `editMessageRemoveButtons`, which relies on exactly that).
   * So editing a cancel-button message's text with `editMessage` would silently
   * delete the cancel button. This re-sends the keyboard from `alert.choices`.
   */
  editAlert?(chatId: string, messageId: string, alert: AlertData, opts?: SendOpts): Promise<void>;

  createTopic?(name: string): Promise<number | string>;
  deleteTopic?(topicId: number | string): Promise<void>;
  probeTopicPresence?(topicId: number | string): Promise<TopicPresence>;
  /**
   * How the fleet may use probeTopicPresence. Absent means "periodic": the
   * 5-minute topology scan probes every route this adapter owns (Discord's
   * passive REST fetch is cheap and silent). "on-demand" means the scan skips
   * this adapter's routes and the probe is only used to confirm a hint that
   * a real delivery already produced (Telegram: the only existence check is a
   * visible send+delete, so it must not run unprompted).
   */
  topicProbePolicy?(): TopicProbePolicy;
  closeForumTopic?(threadId: number | string): Promise<void>;
  reopenForumTopic?(threadId: number | string): Promise<void>;
  editForumTopic?(threadId: number | string, opts: { name?: string; iconCustomEmojiId?: string }): Promise<void>;
  getTopicIconStickers?(): Promise<{ customEmojiId: string; emoji: string }[]>;
}

export interface ApprovalHandle {
  cancel(): void;
}

/** Where to look for stickers: a Discord channel (its server's stickers), or a Telegram sticker set. */
export interface StickerTarget { chatId?: string; threadId?: string; set?: string }

/**
 * One sticker, the same shape on every platform (#1226). `id` is what `reply.stickers` takes: a Discord sticker id
 * or a Telegram file_id. `emoji_or_tags` is Discord's tags or Telegram's associated emoji.
 */
export interface StickerInfo {
  id: string;
  name: string;
  emoji_or_tags: string;
  /** png / apng / gif / lottie (Discord); webp / tgs / webm (Telegram). */
  format: "png" | "apng" | "gif" | "lottie" | "webp" | "tgs" | "webm";
  /** Discord: false when the server lost the boost level the sticker needs. */
  available: boolean;
  /** Telegram only, never shown to an agent: the thumbnail's file_id, for a preview of an animated sticker. */
  thumbnailId?: string;
}

export interface StickerList {
  /** What the list is of: "server <name or id>" or "set <name>". */
  scope: string;
  stickers: StickerInfo[];
}

export interface StickerPreview { bytes: Buffer; ext: "png" | "gif" | "webp" | "jpg" }

export interface SendOpts {
  /** Private dashboard controls; supported by sendDirect only. */
  choices?: Choice[];
  /** Discord entity suppression for display-only echoes; text must also be neutralised. */
  allowedMentions?: { parse: Array<"roles" | "users" | "everyone"> };
  threadId?: string;
  replyTo?: string;
  /** "html": the caller's own platform HTML. "markdown": an agent's markdown (#1658 — Telegram converts it escape-first). */
  format?: "text" | "html" | "markdown";
  chunkLimit?: number;
  /** Suppress the link/web-page preview for URLs in the message (Telegram). */
  disablePreview?: boolean;
  /**
   * #1266: an agent reply's buttons, on the text's last message (a long text is several). `id` is the platform
   * callback (`rb:<set>:<index>`), never the label or value. Only adapters with `supportsReplyButtons` honour it.
   */
  replyButtons?: Array<{ id: string; label: string }>;
  /** #1823: the reply's buttons are a poll's options: this is how it looks when posted (it replaces `replyButtons`). */
  replyPoll?: PollRender;
  /**
   * #1686: URL buttons on the message's last chunk (Telegram inline_keyboard `url` rows). Ignored by adapters
   * that do not support them (Discord, etc.).
   */
  urlButtons?: Array<{ label: string; url: string }>;
  /**
   * #1990: links on parts of a plain text (Telegram `text_link` entities; UTF-16 offsets into the text). Only Telegram
   * honours them, and only on a plain-text send that fits one message; Discord's links are in the text itself.
   */
  textLinks?: import("../topic-link.js").TextLink[];
}

/** #1266: how a reply's buttons end — one chosen (by whom), or expired with none chosen. */
export type ReplyButtonsOutcome = { chosenIndex: number; by: string } | { expired: true };

export interface SentMessage {
  messageId: string;
  chatId: string;
  threadId?: string;
  /** #1266: the message that carries `replyButtons` (the last part of a long text). */
  buttonsMessageId?: string;
}

export interface OutboundMessage {
  text?: string;
  filePath?: string;
  threadId?: string;
  replyTo?: string;
  format?: "text" | "html";
}

export interface InboundMessage {
  /** Trusted adapter facts, absent for bots and unknown actor identity. */
  humanOrigin?: import("../human-delivery-receipts.js").HumanOrigin;
  humanOriginalBody?: string;
  source: string;
  adapterId: string;
  chatId: string;
  threadId?: string;
  /**
   * #1085: the platform thread the message really came from, when `threadId`
   * has been set to a ClassicBot registry key (a Telegram chat id). A
   * registered Telegram forum group keys its ClassicBot by chat id, but the
   * agent's reply belongs in the topic it was asked in.
   */
  transportThreadId?: string;
  messageId: string;
  userId: string;
  username: string;
  text: string;
  timestamp: Date;
  isBotMessage?: boolean;
  attachments?: Attachment[];
  replyTo?: string;
  replyToText?: string;
}

/**
 * A user adding or removing a reaction on one of the bot's messages (#408).
 *
 * Emitted as an adapter `reaction` event. `messageId` is the bot's message, which is
 * what lets an agent tell WHICH of its messages was reacted to — the inbound block
 * renders message_id, so the agent can correlate.
 */
export interface InboundReaction {
  source: string;
  adapterId: string;
  chatId: string;
  threadId?: string;
  messageId: string;
  userId: string;
  username: string;
  emoji: string;
  /** Discord server custom emoji id; `emoji` then holds only its name (#1005). */
  emojiId?: string;
  action: "add" | "remove";
  timestamp: Date;
}

export interface Attachment {
  kind: "photo" | "document" | "audio" | "voice" | "video" | "sticker";
  fileId: string;
  localPath?: string;
  mime?: string;
  size?: number;
  filename?: string;
  transcription?: string;
}

export interface PermissionPrompt {
  tool_name: string;
  description: string;
  input_preview?: string;
}

export interface ApprovalResponse {
  decision: "approve" | "approve_always" | "deny";
  respondedBy?: { channelType: string; userId: string };
  reason?: string;
}

export interface Target {
  adapterId?: string;
  chatId: string;
  threadId?: string;
}

export interface QueuedMessage {
  type: "content" | "status_update" | "status_clear";
  text?: string;
  filePath?: string;
  editMessageId?: string;
}
