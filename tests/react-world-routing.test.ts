import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { Daemon } from "../src/daemon.js";
import { FleetManager } from "../src/fleet-manager.js";
import type { Logger } from "../src/logger.js";

const rootLogger = pino({ level: "silent" }) as Logger;

describe("MCP react world routing", () => {
  it("forwards the daemon's exact chat, thread, and adapter context", () => {
    const instanceDir = mkdtempSync(join(tmpdir(), "agend-react-context-"));
    const daemon = new Daemon("general-secondary", {
      working_directory: instanceDir,
      restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
      context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
      log_level: "silent",
    } as any, instanceDir, true, undefined, undefined, rootLogger);
    const broadcast = vi.fn();
    const send = vi.fn();
    (daemon as any).ipcServer = { broadcast, send };
    (daemon as any).lastChatId = "secondary-guild";
    (daemon as any).lastThreadId = "secondary-channel";
    (daemon as any).lastAdapterId = "discord-secondary";

    try {
      (daemon as any).handleToolCall({
        tool: "react",
        args: { message_id: "message-1", emoji: "🎯" },
        requestId: 41,
      }, {} as any);

      expect(broadcast).toHaveBeenCalledWith({
        type: "fleet_outbound",
        tool: "react",
        args: {
          message_id: "message-1",
          emoji: "🎯",
          chat_id: "secondary-guild",
          thread_id: "secondary-channel",
        },
        fleetRequestId: "tool_41",
        adapterId: "discord-secondary",
      });

      // Complete the synthetic request so its production timeout is cleared.
      const complete = (daemon as any).pendingIpcRequests.get("tool_41");
      complete({ result: "ok" });
      expect(send).toHaveBeenCalledWith({}, {
        requestId: 41,
        result: "ok",
        error: undefined,
      });
    } finally {
      rmSync(instanceDir, { recursive: true, force: true });
    }
  });

  it("uses the context world rather than the instance's primary binding", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "agend-react-world-"));
    const fm = new FleetManager(dataDir);
    const primaryReact = vi.fn().mockResolvedValue(undefined);
    const secondaryReact = vi.fn().mockResolvedValue(undefined);
    const primary = { id: "discord-primary", type: "discord", react: primaryReact } as any;
    const secondary = { id: "discord-secondary", type: "discord", react: secondaryReact } as any;
    const send = vi.fn();

    fm.adapter = primary;
    fm.worlds.set("discord-primary", { adapter: primary } as any);
    fm.worlds.set("discord-secondary", { adapter: secondary } as any);
    fm.instanceWorldBinding.set("general-secondary", "discord-primary");
    fm.fleetConfig = {
      defaults: {},
      instances: {
        "general-secondary": {
          working_directory: dataDir,
          general_topic: true,
        },
      },
    } as any;
    fm.instanceIpcClients.set("general-secondary", { send } as any);

    try {
      await (fm as any).handleOutboundFromInstance("general-secondary", {
        type: "fleet_outbound",
        tool: "react",
        args: {
          chat_id: "secondary-guild",
          thread_id: "secondary-channel",
          message_id: "message-1",
          emoji: "🎯",
        },
        fleetRequestId: "tool_41",
        adapterId: "discord-secondary",
      });

      await vi.waitFor(() => expect(send).toHaveBeenCalledWith({
        type: "fleet_outbound_response",
        fleetRequestId: "tool_41",
        result: "ok",
        error: undefined,
      }));
      expect(secondaryReact).toHaveBeenCalledWith(
        "secondary-guild",
        "message-1",
        "🎯",
        "secondary-channel",
      );
      expect(primaryReact).not.toHaveBeenCalled();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("fails closed when persisted context names an unavailable world", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "agend-react-missing-world-"));
    const fm = new FleetManager(dataDir);
    const primaryReact = vi.fn().mockResolvedValue(undefined);
    const primary = { id: "discord-primary", type: "discord", react: primaryReact } as any;
    const send = vi.fn();
    fm.adapter = primary;
    fm.worlds.set("discord-primary", { adapter: primary } as any);
    fm.fleetConfig = {
      defaults: {},
      instances: { agent: { working_directory: dataDir, topic_id: "topic" } },
    } as any;
    fm.instanceIpcClients.set("agent", { send } as any);

    try {
      await (fm as any).handleOutboundFromInstance("agent", {
        type: "fleet_outbound",
        tool: "react",
        args: { chat_id: "guild", message_id: "message", emoji: "🎯" },
        fleetRequestId: "tool_42",
        adapterId: "removed-world",
      });

      expect(send).toHaveBeenCalledWith({
        type: "fleet_outbound_response",
        fleetRequestId: "tool_42",
        result: null,
        error: "Adapter world unavailable: removed-world",
      });
      expect(primaryReact).not.toHaveBeenCalled();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
