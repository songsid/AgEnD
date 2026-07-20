import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
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

function context() {
  const pause = vi.fn(async () => undefined);
  const wake = vi.fn(async () => undefined);
  const ctx = {
    fleetConfig: { defaults: {}, instances: { worker: { working_directory: "/tmp/worker" } } },
    configPath: "/tmp/fleet.yaml",
    dataDir: "/tmp",
    logger: { warn: vi.fn() },
    getRawFleetConfig: () => ({}),
    saveFleetConfig: vi.fn(),
    lifecycle: { isPaused: vi.fn(() => false), pause, wake },
  } as unknown as SettingsApiContext;
  return { ctx, pause, wake };
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
