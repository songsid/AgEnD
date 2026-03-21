import { EventEmitter } from "node:events";
import type { ChannelAdapter, InboundMessage, OutboundMessage, Target, ApprovalResponse } from "./types.js";

const APPROVAL_TIMEOUT_MS = 120_000;

export class MessageBus extends EventEmitter {
  private adapters: Map<string, ChannelAdapter> = new Map();

  register(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.id, adapter);
    adapter.on("message", (msg: InboundMessage) => this.emit("message", msg));
  }

  unregister(adapterId: string): void { this.adapters.delete(adapterId); }
  getAdapter(id: string) { return this.adapters.get(id); }
  getAllAdapters() { return [...this.adapters.values()]; }

  async send(target: Target, msg: OutboundMessage): Promise<void> {
    if (target.adapterId) {
      const adapter = this.adapters.get(target.adapterId);
      if (!adapter) throw new Error(`Adapter ${target.adapterId} not found`);
      await this.sendVia(adapter, target, msg);
    } else {
      await Promise.allSettled(
        [...this.adapters.values()].map(a => this.sendVia(a, target, msg))
      );
    }
  }

  private async sendVia(adapter: ChannelAdapter, target: Target, msg: OutboundMessage) {
    if (msg.filePath) {
      await adapter.sendFile(target.chatId, msg.filePath, { threadId: target.threadId });
    } else if (msg.text) {
      await adapter.sendText(target.chatId, msg.text, {
        threadId: target.threadId, replyTo: msg.replyTo, format: msg.format,
      });
    }
  }

  requestApproval(prompt: string): Promise<ApprovalResponse> {
    return new Promise((resolve) => {
      const controller = new AbortController();
      const handles: Array<{ cancel(): void }> = [];
      let resolved = false;

      const timeout = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        controller.abort();
        handles.forEach(h => h.cancel());
        resolve({ decision: "deny", respondedBy: { channelType: "timeout", userId: "" } });
      }, APPROVAL_TIMEOUT_MS);

      if (this.adapters.size === 0) {
        clearTimeout(timeout);
        resolve({ decision: "deny", respondedBy: { channelType: "none", userId: "" } });
        return;
      }

      for (const adapter of this.adapters.values()) {
        adapter.sendApproval(prompt, (decision) => {
          if (resolved) return;
          resolved = true;
          clearTimeout(timeout);
          controller.abort();
          handles.forEach(h => h.cancel());
          resolve({ decision, respondedBy: { channelType: adapter.type, userId: adapter.id } });
        }, controller.signal).then(handle => handles.push(handle)).catch(() => {});
      }
    });
  }
}
