import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleSettingsRequest, type SettingsApiContext } from "../src/settings-api.js";

function request(
  path: string,
  ctx: SettingsApiContext,
  method = "POST",
  body?: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter() as EventEmitter & { method: string; destroy(): void };
    req.method = method;
    req.destroy = () => undefined;
    let status = 0;
    const res = {
      writeHead(code: number) { status = code; },
      end(payload: string) { resolve({ status, body: JSON.parse(payload) as Record<string, unknown> }); },
    };
    try {
      expect(handleSettingsRequest(req as never, res as never, new URL(`http://localhost${path}`), ctx)).toBe(true);
      if (body !== undefined) queueMicrotask(() => {
        req.emit("data", Buffer.from(JSON.stringify(body)));
        req.emit("end");
      });
    } catch (err) { reject(err); }
  });
}

function context(dataDir = "/tmp") {
  const pause = vi.fn(async () => undefined);
  const wake = vi.fn(async () => undefined);
  const restartClassicInstanceFromSettings = vi.fn(async () => undefined);
  const ctx = {
    fleetConfig: { defaults: {}, instances: { worker: { working_directory: "/tmp/worker" } } },
    configPath: "/tmp/fleet.yaml",
    dataDir,
    logger: { warn: vi.fn(), info: vi.fn() },
    getRawFleetConfig: () => ({}),
    saveFleetConfig: vi.fn(),
    lifecycle: { isPaused: vi.fn(() => false), pause, wake },
    restartClassicInstanceFromSettings,
  } as unknown as SettingsApiContext;
  return { ctx, pause, wake, restartClassicInstanceFromSettings };
}

describe("Settings manual lifecycle API", () => {
  it("pauses a configured instance", async () => {
    const { ctx, pause } = context();
    const response = await request("/api/settings/instances/worker/pause", ctx);
    expect(response).toEqual({ status: 200, body: { ok: true, name: "worker", status: "paused" } });
    expect(pause).toHaveBeenCalledWith("worker");
  });

  it("wakes a configured instance with the UI timeout", async () => {
    const { ctx, wake } = context();
    const response = await request("/api/settings/instances/worker/wake", ctx);
    expect(response.status).toBe(200);
    expect(wake).toHaveBeenCalledWith("worker", 30_000);
  });

  it("does not invoke lifecycle for an unknown instance", async () => {
    const { ctx, pause } = context();
    const response = await request("/api/settings/instances/missing/pause", ctx);
    expect(response.status).toBe(404);
    expect(pause).not.toHaveBeenCalled();
  });

  it("merges nested hang settings and removes inherited override sent as null", async () => {
    const { ctx } = context();
    const instance = ctx.fleetConfig!.instances.worker as unknown as Record<string, unknown>;
    instance.agent_mode = "cli";
    instance.hang_detector = { enabled: true, timeout_minutes: 15 };
    const response = await request(
      "/api/settings/fleet/instances/worker",
      ctx,
      "PATCH",
      { agent_mode: null, hang_detector: { timeout_minutes: 9 } },
    );
    expect(response.status).toBe(200);
    const saved = ctx.fleetConfig!.instances.worker as unknown as Record<string, unknown>;
    expect(saved.agent_mode).toBeUndefined();
    expect(saved.hang_detector).toEqual({ enabled: true, timeout_minutes: 9 });
    expect(ctx.saveFleetConfig).toHaveBeenCalledOnce();
    expect(ctx.saveFleetConfig).toHaveBeenCalledWith(expect.arrayContaining([
      { path: ["instances", "worker", "agent_mode"], value: null, remove: true },
      { path: ["instances", "worker", "hang_detector", "timeout_minutes"], value: 9, remove: false },
    ]));
  });

  it("removes only the hang timeout override while preserving enabled", async () => {
    const { ctx } = context();
    const instance = ctx.fleetConfig!.instances.worker as unknown as Record<string, unknown>;
    instance.hang_detector = { enabled: false, timeout_minutes: 15 };
    const response = await request(
      "/api/settings/fleet/instances/worker",
      ctx,
      "PATCH",
      { hang_detector: { timeout_minutes: null } },
    );
    expect(response.status).toBe(200);
    const saved = ctx.fleetConfig!.instances.worker as unknown as Record<string, unknown>;
    expect(saved.hang_detector).toEqual({ enabled: false });
  });
});

describe("Settings classicBot persistence", () => {
  const dirs: string[] = [];
  const makeDir = () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-settings-classic-"));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  it("rejects malformed classicBot.yaml without overwriting it", async () => {
    const dir = makeDir();
    const path = join(dir, "classicBot.yaml");
    const malformed = "defaults: [unterminated\n";
    writeFileSync(path, malformed);
    const { ctx } = context(dir);

    const response = await request("/api/settings/classic/defaults", ctx, "PUT", { backend: "codex" });

    expect(response.status).toBe(409);
    expect(String(response.body.error)).toContain("classicBot.yaml is invalid");
    expect(readFileSync(path, "utf8")).toBe(malformed);
  });

  it("atomically replaces classicBot.yaml and preserves its permissions", async () => {
    const dir = makeDir();
    const path = join(dir, "classicBot.yaml");
    writeFileSync(path, "defaults:\n  backend: claude-code\nchannels:\n  keep: true\n");
    chmodSync(path, 0o640);
    const { ctx } = context(dir);

    const response = await request("/api/settings/classic/defaults", ctx, "PUT", { backend: "codex" });

    expect(response.status).toBe(200);
    const saved = yaml.load(readFileSync(path, "utf8")) as any;
    expect(saved.defaults.backend).toBe("codex");
    expect(saved.channels.keep).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o640);
    expect(readdirSync(dir).filter(name => name.includes(".tmp-"))).toEqual([]);
  });

  it("patches a Classic channel and restarts its running instance", async () => {
    const dir = makeDir();
    const path = join(dir, "classicBot.yaml");
    writeFileSync(path, yaml.dump({
      defaults: { backend: "claude-code" },
      channels: { "123#discord": { instanceName: "classic-demo-0123", backend: "codex", collab: false } },
    }));
    const { ctx, restartClassicInstanceFromSettings } = context(dir);

    const response = await request(
      "/api/settings/classic/channels/123%23discord",
      ctx,
      "PATCH",
      { backend: "opencode", model: "test-model", collab: true, context_lines: 8 },
    );

    expect(response.status).toBe(200);
    const saved = yaml.load(readFileSync(path, "utf8")) as any;
    expect(saved.channels["123#discord"]).toMatchObject({ backend: "opencode", model: "test-model", collab: true, context_lines: 8 });
    expect(restartClassicInstanceFromSettings).toHaveBeenCalledWith("classic-demo-0123");
  });

  it("rejects invalid Classic channel fields without writing", async () => {
    const dir = makeDir();
    const path = join(dir, "classicBot.yaml");
    const original = "channels:\n  channel-one:\n    instanceName: classic-one\n    backend: codex\n";
    writeFileSync(path, original);
    const { ctx, restartClassicInstanceFromSettings } = context(dir);

    const response = await request("/api/settings/classic/channels/channel-one", ctx, "PATCH", { backend: "unknown" });

    expect(response.status).toBe(400);
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(restartClassicInstanceFromSettings).not.toHaveBeenCalled();
  });

  it("rolls back the Classic channel config when restart fails", async () => {
    const dir = makeDir();
    const path = join(dir, "classicBot.yaml");
    const initial = { channels: { one: { instanceName: "classic-one", backend: "codex" } } };
    writeFileSync(path, yaml.dump(initial));
    const { ctx, restartClassicInstanceFromSettings } = context(dir);
    restartClassicInstanceFromSettings.mockRejectedValueOnce(new Error("startup failed"));

    const response = await request("/api/settings/classic/channels/one", ctx, "PATCH", { backend: "opencode" });

    expect(response.status).toBe(409);
    expect(yaml.load(readFileSync(path, "utf8"))).toEqual(initial);
  });
});
