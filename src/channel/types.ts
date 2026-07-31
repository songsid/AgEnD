import { EventEmitter } from "node:events";

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
  type: "hang" | "cost_warn" | "cost_limit" | "schedule_deferred" | "rotation" | "cancel";
  instanceName: string;
  message: string;
  choices?: Choice[];
}

export interface ChannelAdapter extends EventEmitter {
  readonly type: string;
  readonly id: string;

  start(): Promise<void>;
  stop(): Promise<void>;

  sendText(chatId: string, text: string, opts?: SendOpts): Promise<SentMessage>;
  sendFile(chatId: string, filePath: string, opts?: SendOpts): Promise<SentMessage>;
  /** threadId locates the message when it lives in a topic/thread (Discord forum
   * topics are their own channel and won't be found by a guild text-channel scan). */
  editMessage(chatId: string, messageId: string, text: string, threadId?: string): Promise<void>;
  /** Edit a message's text AND remove any inline buttons/components. Used to
   * retire a Cancel button after the agent replies or a timeout elapses.
   * threadId locates the message when it lives in a topic/thread (Discord
   * forum topics are their own channel and won't be found by a guild scan). */
  editMessageRemoveButtons?(chatId: string, messageId: string, text: string, threadId?: string): Promise<void>;
  /** Delete a message (e.g. retire the Cancel button message when done).
   * threadId locates the message when it lives in a topic/thread. */
  deleteMessage?(chatId: string, messageId: string, threadId?: string): Promise<void>;
  /** React to a message. threadId locates a message in a topic/thread (Discord
   * threads are their own channel; Telegram reactions key on the supergroup
   * chat_id and ignore it). */
  react(chatId: string, messageId: string, emoji: string, threadId?: string): Promise<void>;

  sendApproval(
    prompt: PermissionPrompt,
    callback: (decision: "approve" | "approve_always" | "deny") => void,
    signal?: AbortSignal,
    threadId?: string,
  ): Promise<ApprovalHandle>;

  downloadAttachment(fileId: string): Promise<string>;

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
  topicExists?(topicId: number | string): Promise<boolean>;
  closeForumTopic?(threadId: number | string): Promise<void>;
  reopenForumTopic?(threadId: number | string): Promise<void>;
  editForumTopic?(threadId: number | string, opts: { name?: string; iconCustomEmojiId?: string }): Promise<void>;
  getTopicIconStickers?(): Promise<{ customEmojiId: string; emoji: string }[]>;
}

export interface ApprovalHandle {
  cancel(): void;
}

export interface SendOpts {
  threadId?: string;
  replyTo?: string;
  format?: "text" | "html";
  chunkLimit?: number;
  /** Suppress the link/web-page preview for URLs in the message (Telegram). */
  disablePreview?: boolean;
}

export interface SentMessage {
  messageId: string;
  chatId: string;
  threadId?: string;
}

export interface OutboundMessage {
  text?: string;
  filePath?: string;
  threadId?: string;
  replyTo?: string;
  format?: "text" | "html";
}

export interface InboundMessage {
  source: string;
  adapterId: string;
  chatId: string;
  threadId?: string;
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
