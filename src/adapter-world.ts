import type { ChannelAdapter, SendOpts, SentMessage } from "./channel/types.js";
import type { AccessManager } from "./channel/access-manager.js";
import type { ChannelConfig } from "./types.js";

/**
 * AdapterWorld encapsulates a single channel adapter with its associated
 * access manager and config. Each platform (Telegram, Discord) gets its
 * own world. Instances are bound to exactly one world.
 */
export class AdapterWorld {
  constructor(
    readonly id: string,
    readonly adapter: ChannelAdapter,
    readonly accessManager: AccessManager,
    readonly channelConfig: ChannelConfig,
  ) {}

  get groupId(): string { return String(this.channelConfig.group_id ?? ""); }
  get type(): string { return this.channelConfig.type; }

  // ── Thin wrappers over adapter ──

  sendText(chatId: string, text: string, opts?: SendOpts): Promise<SentMessage> {
    return this.adapter.sendText(chatId, text, opts);
  }

  react(chatId: string, messageId: string, emoji: string): Promise<void> {
    return this.adapter.react(chatId, messageId, emoji);
  }

  editMessage(chatId: string, messageId: string, text: string): Promise<void> {
    return this.adapter.editMessage(chatId, messageId, text);
  }

  downloadAttachment(fileId: string): Promise<string> {
    return this.adapter.downloadAttachment(fileId);
  }

  isAllowed(userId: string | number): boolean {
    return this.accessManager.isAllowed(userId);
  }

  async stop(): Promise<void> {
    await this.adapter.stop();
  }
}
