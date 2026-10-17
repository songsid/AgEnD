import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { ClassicChannelManager } from "../src/classic-channel-manager.js";
import { DeliveryOutbox } from "../src/delivery-outbox.js";
import { outboundHandlers } from "../src/outbound-handlers.js";
import { DeliveryStatusArgs, validateArgs } from "../src/outbound-schemas.js";
import { OUTBOUND_TOOL_SCHEMAS, TOOLS, usesChannelAddress } from "../src/channel/mcp-tools.js";

// No fleet is started. The real dispatcher/router run with private stores and
// inert adapter methods; the exhaustive table replaces handlers before calls.
const roots: string[] = [];
const stores: DeliveryOutbox[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function harness(type: "discord" | "telegram" = "discord", classic = true) {
  const root = mkdtempSync(join(tmpdir(), "agend-classic-address-"));
  roots.push(root);
  const fm = new FleetManager(root);
  const adapter = {
    id: "owner", type,
    sendText: vi.fn().mockResolvedValue({ messageId: "sent", chatId: "room" }),
    react: vi.fn().mockResolvedValue(undefined),
    editMessage: vi.fn().mockResolvedValue(undefined),
    downloadAttachment: vi.fn().mockResolvedValue("/fixture/file"),
  };
  fm.adapter = adapter as never;
  fm.worlds.set("owner", { id: "owner", adapter } as never);
  fm.fleetConfig = {
    defaults: {},
    instances: { classic: { working_directory: root, tool_set: "full", topic_id: "fleet-topic" } },
  } as never;
  if (classic) {
    const channels = new ClassicChannelManager(root, fm.logger);
    channels.setPrimaryAdapterId("owner");
    channels.register("room", "owner", "classic", "test room", "user", "claude-code");
    fm.classicChannels = channels;
  }
  vi.spyOn(fm as never as { touchActivity(): void }, "touchActivity").mockImplementation(() => {});
  vi.spyOn(fm as never as { setTopicIcon(): void }, "setTopicIcon").mockImplementation(() => {});
  vi.spyOn(fm as never as { afterReplyRouted(): void }, "afterReplyRouted").mockImplementation(() => {});
  const send = vi.fn((_message: Record<string, unknown>) => true);
  fm.instanceIpcClients.set("classic", { send } as never);
  const dispatch = async (tool: string, args: Record<string, unknown>) => {
    send.mockClear();
    await (fm as unknown as {
      handleOutboundFromInstance(name: string, message: Record<string, unknown>): Promise<void>;
    }).handleOutboundFromInstance("classic", { tool, args, fleetRequestId: "request", adapterId: "owner" });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    return send.mock.calls[0]![0] as unknown as { result: unknown; error?: string };
  };
  return { fm, root, adapter, dispatch };
}

const samples: Record<string, Record<string, unknown>> = {
  reply: { text: "hello" }, react: { message_id: "m", emoji: "👍" },
  edit_message: { message_id: "m", text: "edited" }, download_attachment: { file_id: "file" },
  validate_config: {}, create_schedule: { cron: "0 7 * * *", message: "hello" }, list_schedules: {},
  update_schedule: { id: "schedule" }, delete_schedule: { id: "schedule" }, task: { action: "list" },
  post_decision: { title: "decision", content: "content" }, list_decisions: {}, update_decision: { id: "decision" },
  broadcast: { message: "hello" }, send_to_instance: { instance_name: "peer", message: "hello" },
  request_information: { target_instance: "peer", question: "question" },
  delegate_task: { target_instance: "peer", task: "task" }, report_result: { target_instance: "peer", summary: "done" },
  delivery_status: { message_id: "message" }, create_team: { name: "team", members: [] },
  delete_team: { name: "team" }, list_teams: {}, update_team: { name: "team" },
  describe_instance: { name: "peer" }, list_instances: {}, start_instance: { name: "peer" },
  restart_instance: { name: "peer" }, pause_instance: { name: "peer" }, wake_instance: { name: "peer" },
  stop_instance: { name: "peer" }, get_fleet_status: {}, get_effort: {}, kiro_engine_status: {}, close_poll: { poll_id: "a".repeat(32) },
  get_usage: {}, get_cache_report: { window: "24h" }, list_models: {}, get_instance_logs: { name: "peer" }, get_fleet_config: {},
  update_instance_config: { name: "peer", config: {} }, update_fleet_defaults: { defaults: {} },
  create_instance: {}, delete_instance: { name: "peer" }, replace_instance: { name: "peer" },
  set_display_name: { name: "test" }, list_emojis: {}, preview_emojis: { emojis: ["👍"] },
  list_stickers: {}, preview_stickers: { stickers: ["sticker"] }, set_persona_emoji: { emoji: "👍" },
  set_description: { description: "test" }, checkout_repo: { source: "/fixture/repo" },
  get_web_theme: {}, set_web_theme: { set: { font: "mono" } }, set_web_theme_asset: { slot: "avatar", file: "a.png" }, reset_web_theme: {},
  get_web_appearance: {}, preview_web_appearance: { modes: ["dark"] },
  set_web_widget: { slot: "details", data: { prs: 1 } }, remove_web_widget: { slot: "details" },
  export_web_mod: { name: "look", version: "1.0.0" }, propose_web_mod: { file: "look.agendmod.json" },
  upload_web_effect: { dir: "./effect" }, list_web_effects: {},
  preview_web_effect: { id: "a".repeat(32) }, profile_web_effect: { id: "a".repeat(32) },
  apply_web_effect: { id: "a".repeat(32), params: { density: 2 } }, remove_web_effect: {}, delete_web_effect: { id: "a".repeat(32) },
  release_repo: { path: "/fixture/worktree" }, deploy_template: { template: "test", directory: "/fixture/repo" },
  teardown_deployment: { name: "test" }, list_deployments: {},
};

describe("ClassicBot outbound address scope (#1626)", () => {
  it("tables every outbound tool and derives channel addressing from its runtime schema", () => {
    expect(Object.keys(samples).sort()).toEqual(TOOLS.map(tool => tool.name).sort());
    expect([...OUTBOUND_TOOL_SCHEMAS.keys()].sort()).toEqual(Object.keys(samples).sort());
    for (const [tool, schema] of OUTBOUND_TOOL_SCHEMAS) {
      const properties = z.toJSONSchema(schema).properties ?? {};
      expect(usesChannelAddress(tool), tool).toBe(Object.hasOwn(properties, "chat_id"));
      expect(validateArgs(schema, samples[tool], tool).ok, tool).toBe(true);
    }
    expect(usesChannelAddress("constructor")).toBe(false);
    expect(usesChannelAddress("unknown_tool")).toBe(false);
  });

  it("keeps internal addresses out of every public MCP listing", () => {
    for (const tool of TOOLS) {
      expect(tool.inputSchema.properties, tool.name).not.toHaveProperty("chat_id");
      expect(tool.inputSchema.properties, tool.name).not.toHaveProperty("thread_id");
    }
  });

  for (const tool of Object.keys(samples)) {
    it(`${tool}: validates actual ClassicBot dispatch args without injecting non-channel metadata`, async () => {
      const h = harness();
      const schema = OUTBOUND_TOOL_SCHEMAS.get(tool)!;
      const args = { ...samples[tool] };
      const recorded: Record<string, unknown>[] = [];
      const original = outboundHandlers.get(tool);
      // Channel calls exercise the real router and fake adapter. Everything
      // else is intercepted at its handler boundary, before any effect.
      outboundHandlers.set(tool, (_ctx, raw, respond) => {
        recorded.push(raw);
        const validated = validateArgs(schema, raw, tool);
        respond(validated.ok ? "validated" : null, validated.ok ? undefined : validated.error);
      });
      try {
        const result = await h.dispatch(tool, args);
        expect(result.error).toBeUndefined();
        expect(validateArgs(schema, args, tool).ok).toBe(true);
        if (usesChannelAddress(tool)) {
          expect(args).toMatchObject({ chat_id: "room" });
          expect(args).not.toHaveProperty("thread_id");
        } else {
          expect(args).toEqual(samples[tool]);
          // validate_config is a stateless real router handler, not in the map.
          if (tool !== "validate_config") expect(recorded).toEqual([samples[tool]]);
        }
      } finally {
        if (original) outboundHandlers.set(tool, original);
        else outboundHandlers.delete(tool);
      }
    });
  }

  it.each(["message_id", "correlation_id"] as const)("real delivery_status accepts only %s from a ClassicBot", async selector => {
    const h = harness();
    const store = new DeliveryOutbox(join(h.root, "outbox.db"), "fixture-boot");
    stores.push(store);
    h.fm.deliveryOutbox = store;
    const row = store.admit({
      operationId: "operation", sourceKey: "key", sourceInstance: "classic", sourceDaemonBootId: "boot",
      targetInstance: "peer", kind: "fleet_inbound", correlationId: "correlation",
      payload: { type: "fleet_inbound", content: "hello", meta: { message_id: "message" } },
    }).delivery;
    const args = selector === "message_id" ? { message_id: "message" } : { correlation_id: "correlation" };
    const result = await h.dispatch("delivery_status", args);
    expect(result.error).toBeUndefined();
    expect(result.result).toMatchObject({ items: [{ delivery_id: row.deliveryId }], next_cursor: null });
    expect(args).not.toHaveProperty("chat_id");
    expect(args).not.toHaveProperty("thread_id");
  });

  it.each(["chat_id", "thread_id", "caller_instance"])("delivery_status still refuses agent-supplied %s", async field => {
    const h = harness();
    const args = { message_id: "message", [field]: "spoofed" };
    expect(DeliveryStatusArgs.safeParse(args).success).toBe(false);
    const result = await h.dispatch("delivery_status", args);
    expect(result.result).toBeNull();
    expect(result.error).toContain("Unrecognized key");
  });

  it.each(["reply", "react", "edit_message", "download_attachment"])("%s still forces the Classic Discord room", async tool => {
    const h = harness();
    const args = { ...samples[tool], chat_id: "another-room", thread_id: "another-thread" };
    expect((await h.dispatch(tool, args)).error).toBeUndefined();
    expect(args).toMatchObject({ chat_id: "room" });
    expect(args).not.toHaveProperty("thread_id");
    if (tool === "reply") expect(h.adapter.sendText.mock.calls[0]).toMatchObject(["room", "hello", { threadId: undefined }]);
    if (tool === "react") expect(h.adapter.react).toHaveBeenCalledWith("room", "m", "👍", undefined);
    if (tool === "edit_message") expect(h.adapter.editMessage).toHaveBeenCalledWith("room", "m", "edited", undefined);
    if (tool === "download_attachment") expect(h.adapter.downloadAttachment).toHaveBeenCalledWith("file");
  });

  it.each(["reply", "react", "edit_message"])("%s retains Telegram Classic forum context", async tool => {
    const h = harness("telegram");
    const args = { ...samples[tool], chat_id: "another-room", thread_id: "30" };
    expect((await h.dispatch(tool, args)).error).toBeUndefined();
    expect(args).toMatchObject({ chat_id: "room", thread_id: "30" });
    if (tool === "reply") expect(h.adapter.sendText.mock.calls[0]).toMatchObject(["room", "hello", { threadId: "30" }]);
    if (tool === "react") expect(h.adapter.react).toHaveBeenCalledWith("room", "m", "👍", "30");
    if (tool === "edit_message") expect(h.adapter.editMessage).toHaveBeenCalledWith("room", "m", "edited", "30");
  });

  it.each(["reply", "react", "edit_message", "download_attachment"])("%s clears a threadless Telegram chat-id echo", async tool => {
    const h = harness("telegram");
    const args = { ...samples[tool], chat_id: "wrong-room", thread_id: "room" };
    expect((await h.dispatch(tool, args)).error).toBeUndefined();
    expect(args).toMatchObject({ chat_id: "room" });
    expect(args).not.toHaveProperty("thread_id");
    if (tool === "reply") expect(h.adapter.sendText.mock.calls[0]).toMatchObject(["room", "hello", { threadId: undefined }]);
    if (tool === "react") expect(h.adapter.react).toHaveBeenCalledWith("room", "m", "👍", undefined);
    if (tool === "edit_message") expect(h.adapter.editMessage).toHaveBeenCalledWith("room", "m", "edited", undefined);
  });

  it("keeps fleet-topic addressing unchanged", async () => {
    const h = harness("discord", false);
    const args = { ...samples.react, chat_id: "guild", thread_id: "topic" };
    expect((await h.dispatch("react", args)).error).toBeUndefined();
    expect(h.adapter.react).toHaveBeenCalledWith("guild", "m", "👍", "topic");
  });
});
