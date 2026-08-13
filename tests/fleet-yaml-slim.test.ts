import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { handleSettingsRequest } from "../src/settings-api.js";
import { outboundHandlers } from "../src/outbound-handlers.js";

const dirs: string[] = [];

function fixture(source: string): { dir: string; path: string; fm: FleetManager } {
  const dir = mkdtempSync(join(tmpdir(), "agend-fleet-slim-"));
  dirs.push(dir);
  const path = join(dir, "fleet.yaml");
  writeFileSync(path, source);
  const fm = new FleetManager(dir);
  fm.loadConfig(path);
  return { dir, path, fm };
}

function settingsRequest(
  fm: FleetManager,
  path: string,
  method = "GET",
  body?: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter() as EventEmitter & { method: string; destroy(): void };
    req.method = method;
    req.destroy = () => undefined;
    let status = 0;
    const res = {
      writeHead(code: number) { status = code; },
      end(payload: string) { resolve({ status, body: JSON.parse(payload) }); },
    };
    try {
      expect(handleSettingsRequest(req as never, res as never, new URL(`http://localhost${path}`), fm)).toBe(true);
      if (body !== undefined) queueMicrotask(() => {
        req.emit("data", Buffer.from(JSON.stringify(body)));
        req.emit("end");
      });
    } catch (err) { reject(err); }
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("fleet.yaml default slimming", () => {
  it("removes only matching operational leaves, preserves identity/comments, and writes an exact backup", () => {
    const source = `# fleet header
defaults:
  backend: claude-code
  model: sonnet
  auto_pause_after: 30
  terminal:
    enabled: true
    columns: 120
    rows: 36
  hang_detector:
    enabled: true
    timeout_minutes: 15
instances:
  worker:
    working_directory: /tmp/worker
    topic_id: 42
    display_name: Worker
    description: Keeps identity
    tags: [review]
    backend: claude-code
    model: sonnet
    auto_pause_after: 30 # redundant operational value
    terminal:
      enabled: true
      columns: 120
      rows: 36
    hang_detector:
      enabled: true
      timeout_minutes: 9 # real nested override
    future_option: keep-me
`;
    const { path, fm } = fixture(source);
    const before = structuredClone(fm.fleetConfig!.instances.worker);

    fm.saveFleetConfig();

    expect(readFileSync(`${path}.bak`, "utf8")).toBe(source);
    const text = readFileSync(path, "utf8");
    expect(text).toContain("# fleet header");
    expect(text).toContain("# real nested override");
    const raw = yaml.load(text) as any;
    expect(raw.instances.worker).toMatchObject({
      working_directory: "/tmp/worker",
      topic_id: 42,
      display_name: "Worker",
      description: "Keeps identity",
      tags: ["review"],
      backend: "claude-code",
      model: "sonnet",
      hang_detector: { timeout_minutes: 9 },
      future_option: "keep-me",
    });
    expect(raw.instances.worker.auto_pause_after).toBeUndefined();
    expect(raw.instances.worker.terminal).toBeUndefined();
    expect(raw.instances.worker.hang_detector.enabled).toBeUndefined();

    const reloaded = new FleetManager(join(path, "runtime"));
    reloaded.loadConfig(path);
    expect(reloaded.fleetConfig!.instances.worker).toEqual(before);
  });

  it("Settings reads effective defaults, exposes slim raw YAML, and PATCH does not expand boilerplate", async () => {
    const { path, fm } = fixture(`defaults:
  backend: kiro-cli
  model: auto
  auto_pause_after: 30
instances:
  worker:
    working_directory: /tmp/worker
    auto_pause_after: 30
`);
    fm.saveFleetConfig();

    const effective = await settingsRequest(fm, "/api/settings/fleet");
    const raw = await settingsRequest(fm, "/api/settings/fleet/raw");
    expect(effective.body.instances.worker).toMatchObject({
      backend: "kiro-cli",
      model: "auto",
      auto_pause_after: 30,
      terminal: { enabled: true, columns: 120, rows: 36 },
    });
    expect(raw.body.instances.worker).toEqual({ working_directory: "/tmp/worker" });

    const patched = await settingsRequest(
      fm,
      "/api/settings/fleet/instances/worker",
      "PATCH",
      { auto_pause_after: 45 },
    );
    expect(patched.status).toBe(200);
    const saved = yaml.load(readFileSync(path, "utf8")) as any;
    expect(saved.instances.worker).toEqual({ working_directory: "/tmp/worker", auto_pause_after: 45 });
  });

  it("MCP update/describe and runtime effort/model keep using effective config without re-expansion", async () => {
    const { path, fm } = fixture(`defaults:
  backend: claude-code
  model: sonnet
  auto_pause_after: 30
instances:
  worker:
    working_directory: /tmp/worker
    auto_pause_after: 30
`);
    fm.saveFleetConfig();
    const meta = { instanceName: "sender", requestId: undefined, fleetRequestId: undefined, senderSessionName: undefined };
    let updateResult: unknown;
    await outboundHandlers.get("update_instance_config")!(
      fm,
      { name: "worker", config: { auto_pause_after: 45 } },
      (result) => { updateResult = result; },
      meta,
    );
    expect(updateResult).toMatchObject({ success: true });

    let described: any;
    await outboundHandlers.get("describe_instance")!(
      fm,
      { name: "worker" },
      (result) => { described = result; },
      meta,
    );
    expect(described).toMatchObject({ backend: "claude-code", model: "sonnet" });

    (fm.instanceIpcClients as Map<string, any>).set("worker", { send: vi.fn() });
    expect(await fm.applyEffort("worker", "high")).toContain("runtime");
    expect(await fm.applyModel("worker", "opus")).toContain("runtime");
    const saved = yaml.load(readFileSync(path, "utf8")) as any;
    expect(saved.instances.worker).toEqual({
      working_directory: "/tmp/worker",
      auto_pause_after: 45,
      effort: "high",
      model: "opus",
    });
  });

  it("startup migration invokes the production save path only when redundant values exist", () => {
    const { path, fm } = fixture(`defaults:
  auto_pause_after: 30
instances:
  worker:
    working_directory: /tmp/worker
    auto_pause_after: 30
`);
    (fm as any).slimFleetConfigAtStartup();
    const raw = yaml.load(readFileSync(path, "utf8")) as any;
    expect(raw.instances.worker).toEqual({ working_directory: "/tmp/worker" });
    expect(readFileSync(`${path}.bak`, "utf8")).toContain("auto_pause_after: 30");
  });
});
