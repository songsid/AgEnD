import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { TopicCommands } from "../src/topic-commands.js";
import { handleViewRequest, type ViewApiContext } from "../src/view-api.js";

function responseCapture() {
  const output = { code: 0, body: "" };
  const response = {
    writeHead(code: number) {
      output.code = code;
      return response;
    },
    end(body?: string) {
      output.body = body ?? "";
    },
  } as unknown as ServerResponse;
  return { response, output };
}

describe("Classic effective backend surfaces", () => {
  it("/ctx passes the fleet default through the Classic backend resolver", async () => {
    const getBackendByInstance = vi.fn((_name: string, fleetDefault?: string) => fleetDefault ?? "claude-code");
    const commands = new TopicCommands({
      fleetConfig: {
        defaults: { backend: "kiro-cli" },
        instances: {},
      },
      classicChannels: {
        getChannelIdByInstance: (name: string) => name === "classic-room" ? "room" : undefined,
        getBackendByInstance,
      },
      dataDir: mkdtempSync(join(tmpdir(), "classic-ctx-")),
      modelDisplayForInstance: () => "auto",
    } as any);

    const text = await commands.getCtxText("classic-room");

    expect(getBackendByInstance).toHaveBeenCalledWith("classic-room", "kiro-cli");
    expect(text).toContain("kiro-cli");
    expect(text).not.toContain("claude-code");
  });

  it("/compact, /clear and /save use the effective Classic backend", async () => {
    const sent: unknown[] = [];
    const getBackendByInstance = vi.fn((_name: string, fleetDefault?: string) => fleetDefault ?? "claude-code");
    const commands = new TopicCommands({
      fleetConfig: {
        defaults: { backend: "kiro-cli" },
        instances: {},
      },
      classicChannels: {
        getChannelIdByInstance: (name: string) => name === "classic-room" ? "room" : undefined,
        getBackendByInstance,
      },
      instanceIpcClients: new Map([
        ["classic-room", { connected: true, send: (message: unknown) => sent.push(message) }],
      ]),
    } as any);

    await commands.sendCompact("classic-room");
    await commands.sendClear("classic-room");
    await commands.sendSave("classic-room", "snapshot");

    expect(getBackendByInstance).toHaveBeenCalledWith("classic-room", "kiro-cli");
    expect(sent).toEqual([
      { type: "raw_paste", content: "/compact" },
      { type: "raw_paste", content: "/clear", confirm_clear: true },
      { type: "raw_paste", content: "/chat save snapshot" },
    ]);
  });

  it("/api/profiles returns effective Classic backend and model", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "classic-profiles-"));
    const getBackendByInstance = vi.fn((_name: string, fleetDefault?: string) => fleetDefault ?? "claude-code");
    const ctx: ViewApiContext = {
      viewToken: null,
      webToken: null,
      dataDir,
      fleetConfig: {
        defaults: { backend: "kiro-cli", model: "gpt-5.6-sol" },
        instances: {},
      } as ViewApiContext["fleetConfig"],
      logger: { debug() {}, info() {}, warn() {}, error() {} } as ViewApiContext["logger"],
      classicChannels: {
        getAll: () => [{ instanceName: "classic-room", name: "Room", channelId: "room" }],
        getBackendByInstance,
      },
      getInstanceStatus: () => "running",
      getUiStatus: () => ({ instances: [] }),
      resolveInstanceModel: () => ({ model: "gpt-5.6-sol" }),
    };
    const { response, output } = responseCapture();

    const handled = handleViewRequest(
      { method: "GET", headers: {} } as IncomingMessage,
      response,
      new URL("http://localhost/api/profiles"),
      ctx,
    );

    expect(handled).toBe(true);
    expect(output.code).toBe(200);
    const profiles = JSON.parse(output.body);
    expect(profiles).toEqual([
      expect.objectContaining({
        instance_name: "classic-room",
        backend: "kiro-cli",
        model: "gpt-5.6-sol",
      }),
    ]);
    expect(getBackendByInstance).toHaveBeenCalledWith("classic-room", "kiro-cli");
  });

  it("/api/profiles uses fleet defaults.backend when instance omits backend", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "fleet-profiles-default-"));
    const ctx: ViewApiContext = {
      viewToken: null,
      webToken: null,
      dataDir,
      fleetConfig: {
        defaults: { backend: "kiro-cli", model: "claude-sonnet-4.6" },
        instances: {
          // inherits defaults.backend — previously View hard-coded "claude-code"
          "agend-leader-t1": { working_directory: "/tmp" },
        },
      } as ViewApiContext["fleetConfig"],
      logger: { debug() {}, info() {}, warn() {}, error() {} } as ViewApiContext["logger"],
      classicChannels: null,
      getInstanceStatus: () => "running",
      getUiStatus: () => ({
        instances: [{ name: "agend-leader-t1", status: "running", context_pct: 42, model: "" }],
      }),
      resolveInstanceModel: () => ({ model: "claude-sonnet-4.6" }),
    };
    const { response, output } = responseCapture();

    handleViewRequest(
      { method: "GET", headers: {} } as IncomingMessage,
      response,
      new URL("http://localhost/api/profiles"),
      ctx,
    );

    const profiles = JSON.parse(output.body);
    expect(profiles).toEqual([
      expect.objectContaining({
        instance_name: "agend-leader-t1",
        backend: "kiro-cli",
        context_pct: 42,
        model: "claude-sonnet-4.6",
      }),
    ]);
  });
});
