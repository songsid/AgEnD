/**
 * M-3770 slice 1.4: PUT /api/settings/fleet/updates — Settings → Version and update's controls write `updates.*` (design
 * #4480 §6) through the settings path: a partial patch (only the keys sent change), validated as fleet.yaml is
 * (updatesProblems), `pin: null` removes the pin, saved to fleet.yaml, and on the public link's list for its admin session.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("../src/logger.js", async original => {
  const silent: Record<string, unknown> = new Proxy({}, { get: (_t, key) => (key === "child" ? () => silent : key === "level" ? "silent" : () => {}) });
  return { ...await original<typeof import("../src/logger.js")>(), createLogger: () => silent };
});
import { request } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "agend-s237-home-"));
process.env.AGEND_HOME = home;
let fm: any, port = 0, cookie = "", csrf = "", dir = "";

function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const r = request({ host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, cookie, "x-agend-csrf": csrf, "content-type": "application/json", ...(data ? { "content-length": String(data.length) } : {}), ...headers } }, (res) => {
      const b: Buffer[] = []; res.on("data", (c: Buffer) => { b.push(c); });
      res.on("end", () => { const t = Buffer.concat(b).toString("utf8"); let j: any = null; try { j = JSON.parse(t); } catch { j = t; } resolve({ status: res.statusCode ?? 0, json: j }); });
    });
    r.on("error", reject); if (data) r.write(data); r.end();
  });
}

beforeAll(async () => {
  const { FleetManager } = await import("../src/fleet-manager.js");
  const { WEB_SESSION_COOKIE } = await import("../src/web-auth.js");
  const { tokenEpoch, csrfTokenFor } = await import("../src/web-session.js");
  dir = mkdtempSync(join(tmpdir(), "agend-s237-fleet-"));
  writeFileSync(join(dir, "fleet.yaml"), ["health_port: 0", "instances:", `  dev:\n    working_directory: ${dir}\n    backend: claude-code`].join("\n") + "\n");
  fm = new FleetManager(dir);
  const q = () => {}; fm.logger = { info: q, warn: q, error: q, debug: q, trace: q, fatal: q, child: () => fm.logger };
  fm.notifyFleetError = () => true; fm.loadConfig(join(dir, "fleet.yaml"));
  fm.lifecycle = { isPaused: () => false, hasWorkLease: () => false, daemons: new Map() };
  fm.getInstanceStatus = () => "running";
  fm.initializeWebAuthTokens(); fm.startHealthServer(0);
  await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true), { timeout: 15_000 });
  port = (fm.healthServer.address() as { port: number }).port;
  fm.initializeWebSessions?.();
  const sid = fm.webSessions.create({ tier: "admin", surface: "local", label: "admin", tokenEpoch: tokenEpoch(fm.getDashboardAccess().token!) }).sessionId;
  cookie = `${WEB_SESSION_COOKIE}=${sid}`; csrf = csrfTokenFor(sid);
}, 30_000);
afterAll(() => { try { fm.healthServer?.close(); } catch { /* closed */ } rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });

const yaml = () => readFileSync(join(dir, "fleet.yaml"), "utf8");

describe("PUT /api/settings/fleet/updates (M-3770 1.4)", () => {
  it("saves the pause windows; only the keys sent change; GET /api/settings/fleet reads them back", async () => {
    const r = await call("PUT", "/api/settings/fleet/updates", { pause: [{ days: [1, 2, 3, 4, 5], from: "09:00", to: "18:00" }] });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.updates).toMatchObject({ mode: "ask", pause: [{ days: [1, 2, 3, 4, 5], from: "09:00", to: "18:00" }], pin: null, maxIdleWait: 24 });
    const r2 = await call("PUT", "/api/settings/fleet/updates", { maxIdleWait: 12, pin: "2.4.0" });
    expect(r2.status).toBe(200);
    const fleet = await call("GET", "/api/settings/fleet");
    expect(fleet.json.updates).toMatchObject({ pause: [{ days: [1, 2, 3, 4, 5], from: "09:00", to: "18:00" }], maxIdleWait: 12, pin: "2.4.0" });
    expect(yaml()).toMatch(/updates:[\s\S]*maxIdleWait: 12/);
    expect(yaml()).toMatch(/pin: 2\.4\.0|pin: "2\.4\.0"|pin: '2\.4\.0'/);
  });
  it("pin: null removes the pin", async () => {
    const r = await call("PUT", "/api/settings/fleet/updates", { pin: null });
    expect(r.status).toBe(200);
    expect(r.json.updates.pin).toBeNull();
    expect(yaml()).not.toMatch(/\bpin:/);
    expect(fm.fleetConfig.updates.pin).toBeUndefined();
  });
  it("refuses what fleet.yaml would refuse, and anything but the four keys; nothing is saved", async () => {
    const before = yaml();
    for (const body of [{ pause: [{ days: [7], from: "09:00", to: "18:00" }] }, { pause: [{ days: [1], from: "09:00", to: "09:00" }] }, { maxIdleWait: 0 }, { maxIdleWait: 1.5 }, { mode: "always" }]) {
      const r = await call("PUT", "/api/settings/fleet/updates", body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.json.error).toBe("invalid_updates");
    }
    expect((await call("PUT", "/api/settings/fleet/updates", { channel: "stable" })).status).toBe(400);
    expect((await call("PUT", "/api/settings/fleet/updates", {})).status).toBe(400);
    expect((await call("PUT", "/api/settings/fleet/updates", [1])).status).toBe(400);
    expect(yaml()).toBe(before);
  });
  it("is on the public link's list (its admin session may change it, as monitoring's)", () => {
    expect(readFileSync("src/public-web-gateway.ts", "utf8")).toContain('if (method === "PUT" && path === "/api/settings/fleet/updates") return true;');
  });
});
