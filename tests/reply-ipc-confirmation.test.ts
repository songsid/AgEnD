import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { Daemon } from "../src/daemon.js";
import { FleetManager } from "../src/fleet-manager.js";
import type { Logger } from "../src/logger.js";

const logger = pino({ level: "silent" }) as Logger;

function makeDaemon(dir: string) {
  return new Daemon("classic-reply", {
    working_directory: dir,
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    log_level: "silent",
  } as any, dir, true, undefined, undefined, logger);
}

describe("reply IPC confirmation", () => {
  it("keeps equal process-local request ids isolated by daemon request id", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-reply-ipc-"));
    const daemon = makeDaemon(dir);
    const broadcast = vi.fn();
    const send = vi.fn(() => true);
    const socketA = { destroyed: false } as any;
    const socketB = { destroyed: false } as any;
    (daemon as any).ipcServer = { broadcast, send };

    try {
      (daemon as any).handleToolCall(
        { tool: "reply", args: { text: "from A" }, requestId: 1 },
        socketA,
      );
      (daemon as any).handleToolCall(
        { tool: "reply", args: { text: "from B" }, requestId: 1 },
        socketB,
      );

      const firstId = broadcast.mock.calls[0][0].fleetRequestId;
      const secondId = broadcast.mock.calls[1][0].fleetRequestId;
      expect(firstId).toBe("tool_1_1");
      expect(secondId).toBe("tool_2_1");
      expect((daemon as any).pendingIpcRequests.size).toBe(2);

      (daemon as any).pendingIpcRequests.get(secondId)({ result: { messageId: "discord-B" } });
      (daemon as any).pendingIpcRequests.get(firstId)({ result: { messageId: "discord-A" } });

      expect(send).toHaveBeenCalledWith(socketB, {
        requestId: 1,
        result: { messageId: "discord-B" },
        error: undefined,
      });
      expect(send).toHaveBeenCalledWith(socketA, {
        requestId: 1,
        result: { messageId: "discord-A" },
        error: undefined,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses one daemon-global sequence across every fleet-forwarded tool family", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-fleet-request-ids-"));
    const daemon = makeDaemon(dir);
    const broadcast = vi.fn();
    const send = vi.fn(() => true);
    const socket = { destroyed: false } as any;
    (daemon as any).ipcServer = { broadcast, send };

    try {
      for (const tool of [
        "set_display_name",
        "task",
        "post_decision",
        "list_schedules",
        "list_instances",
        "reply",
      ]) {
        (daemon as any).handleToolCall({ tool, args: { text: tool }, requestId: 1 }, socket);
      }

      const ids = broadcast.mock.calls.map(call => call[0].fleetRequestId);
      expect(ids).toEqual([
        "dn_1_1",
        "task_2_1",
        "dec_3_1",
        "sched_4_1",
        "xmsg_5_1",
        "tool_6_1",
      ]);
      expect(new Set(ids).size).toBe(ids.length);

      for (const id of ids) {
        const handler = (daemon as any).pendingIpcRequests.get(id);
        // The production response listener removes the entry before invoking it.
        (daemon as any).pendingIpcRequests.delete(id);
        handler({ result: { id } });
      }
      expect((daemon as any).pendingIpcRequests.size).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns the adapter's real message id only after the Classic channel POST resolves", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-reply-confirm-"));
    const fm = new FleetManager(dir);
    let resolvePost!: (value: { messageId: string; chatId: string }) => void;
    const sendText = vi.fn(() => new Promise<{ messageId: string; chatId: string }>(resolve => {
      resolvePost = resolve;
    }));
    const adapter = { id: "discord", type: "discord", sendText } as any;
    const ipcSend = vi.fn(() => true);
    fm.adapter = adapter;
    fm.worlds.set("discord", { adapter } as any);
    fm.instanceIpcClients.set("classic-reply", { send: ipcSend } as any);
    fm.classicChannels = {
      getChannelIdByInstance: vi.fn(() => "discord-channel"),
      getAdapterIdByInstance: vi.fn(() => "discord"),
    } as any;
    const afterReply = vi.spyOn(fm as any, "afterReplyRouted");

    try {
      await (fm as any).handleOutboundFromInstance("classic-reply", {
        type: "fleet_outbound",
        tool: "reply",
        args: { chat_id: "wrong-guild", thread_id: "wrong-thread", text: "confirmed" },
        fleetRequestId: "tool_1_1",
      });

      expect(sendText).toHaveBeenCalledWith("discord-channel", "confirmed", {
        threadId: undefined,
        replyTo: undefined,
        format: undefined,
      });
      expect(ipcSend).not.toHaveBeenCalled();
      expect(afterReply).not.toHaveBeenCalled();

      resolvePost({ messageId: "123456789012345678", chatId: "discord-channel" });
      await vi.waitFor(() => expect(ipcSend).toHaveBeenCalledWith({
        type: "fleet_outbound_response",
        fleetRequestId: "tool_1_1",
        result: { messageId: "123456789012345678", chatId: "discord-channel" },
        error: undefined,
      }));
      expect(afterReply).toHaveBeenCalledOnce();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns an error and records no delivery when the platform POST fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-reply-fail-"));
    const fm = new FleetManager(dir);
    const sendText = vi.fn().mockRejectedValue(new Error("Discord POST failed"));
    const adapter = { id: "discord", type: "discord", sendText } as any;
    const ipcSend = vi.fn(() => true);
    fm.adapter = adapter;
    fm.worlds.set("discord", { adapter } as any);
    fm.instanceIpcClients.set("classic-reply", { send: ipcSend } as any);
    fm.classicChannels = {
      getChannelIdByInstance: vi.fn(() => "discord-channel"),
      getAdapterIdByInstance: vi.fn(() => "discord"),
    } as any;
    const afterReply = vi.spyOn(fm as any, "afterReplyRouted");

    try {
      await (fm as any).handleOutboundFromInstance("classic-reply", {
        type: "fleet_outbound",
        tool: "reply",
        args: { text: "will fail" },
        fleetRequestId: "tool_2_1",
      });

      await vi.waitFor(() => expect(ipcSend).toHaveBeenCalledWith({
        type: "fleet_outbound_response",
        fleetRequestId: "tool_2_1",
        result: null,
        error: "Discord POST failed",
      }));
      expect(afterReply).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a confirmed reply successful when the follow-up cancel bubble fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-reply-cancel-fail-"));
    const fm = new FleetManager(dir);
    const sendText = vi.fn().mockResolvedValue({ messageId: "telegram-real-id", chatId: "telegram-chat" });
    const notifyAlert = vi.fn().mockRejectedValue(new Error("cancel bubble network failure"));
    const adapter = { id: "telegram", type: "telegram", sendText, notifyAlert } as any;
    const ipcSend = vi.fn(() => true);
    fm.adapter = adapter;
    fm.worlds.set("telegram", { adapter, groupId: "telegram-chat" } as any);
    fm.instanceIpcClients.set("classic-reply", { send: ipcSend } as any);
    fm.classicChannels = {
      getChannelIdByInstance: vi.fn(() => "telegram-chat"),
      getAdapterIdByInstance: vi.fn(() => "telegram"),
    } as any;
    vi.spyOn(fm as any, "getInstanceIdle").mockReturnValue(false);

    try {
      await (fm as any).handleOutboundFromInstance("classic-reply", {
        type: "fleet_outbound",
        tool: "reply",
        args: { text: "reply is already delivered" },
        fleetRequestId: "tool_cancel_1",
      });

      await vi.waitFor(() => expect(ipcSend).toHaveBeenCalledWith({
        type: "fleet_outbound_response",
        fleetRequestId: "tool_cancel_1",
        result: { messageId: "telegram-real-id", chatId: "telegram-chat" },
        error: undefined,
      }));
      expect(sendText).toHaveBeenCalledWith("telegram-chat", "reply is already delivered", {
        threadId: undefined,
        replyTo: undefined,
        format: undefined,
      });
      await vi.waitFor(() => expect(notifyAlert).toHaveBeenCalledOnce());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns an immediate error when channel adapters are not ready", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-reply-no-world-"));
    const fm = new FleetManager(dir);
    const ipcSend = vi.fn(() => true);
    fm.instanceIpcClients.set("classic-reply", { send: ipcSend } as any);

    try {
      await (fm as any).handleOutboundFromInstance("classic-reply", {
        type: "fleet_outbound",
        tool: "reply",
        args: { text: "cannot route" },
        fleetRequestId: "tool_3_1",
      });

      expect(ipcSend).toHaveBeenCalledWith({
        type: "fleet_outbound_response",
        fleetRequestId: "tool_3_1",
        result: null,
        error: "Channel adapters are not ready — retry shortly",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
