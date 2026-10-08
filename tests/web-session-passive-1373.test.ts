/**
 * #1373: reads a page makes on its own timer are authorized in full but do not slide the session's idle expiry.
 * Only the person does. Checked through the real health server — the gate in front and the handlers' own re-checks
 * behind it — with `web.view_access: session`, so /view's reads need the session, and a session store on a clock this
 * test moves (forward only; nothing here reads the wall clock).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { request, type IncomingHttpHeaders, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";
import { isPassiveWebRead } from "../src/web-auth.js";
import { WebSessionStore } from "../src/web-session.js";

const HOUR = 3_600_000, MINUTE = 60_000;
const tempDirs: string[] = [];
const fleets: FleetManager[] = [];

afterEach(async () => {
  for (const fm of fleets.splice(0)) {
    const server = (fm as unknown as { healthServer: Server | null }).healthServer;
    await new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve()));
    (fm as unknown as { healthServer: Server | null }).healthServer = null;
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("which reads are passive: an explicit list of method + path", () => {
  it("the timer reads of /ui and /view, GET only", () => {
    for (const path of ["/ui/poll", "/ui/events", "/api/pane/alpha", "/api/pane/a%20b", "/api/profiles", "/api/ai-usage"]) {
      expect(isPassiveWebRead("GET", path), path).toBe(true);
      for (const method of ["POST", "PUT", "DELETE", "HEAD", "PATCH"]) expect(isPassiveWebRead(method, path), `${method} ${path}`).toBe(false);
    }
  });

  it("everything else counts as the person: pages, history, profile and avatar reads, near-miss paths", () => {
    for (const path of ["/ui", "/view", "/settings", "/ui/history", "/ui/status", "/api/profile/alpha", "/api/avatar/alpha",
      "/api/sort-order", "/api/pane", "/api/pane/", "/api/pane/a/b", "/ui/poll/x", "/ui/events/", "/api/profiles/x", "/api/ai-usage/x",
      "/UI/POLL", "/auth/session", "/status"]) {
      expect(isPassiveWebRead("GET", path), path).toBe(false);
    }
  });
});

interface Res { status: number; headers: IncomingHttpHeaders }

/** A request that resolves on the response headers and then drops the connection (an SSE stream never ends). */
function hit(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers }, res => {
      resolve({ status: res.statusCode ?? 0, headers: res.headers });
      res.resume();
      if (String(res.headers["content-type"] ?? "").includes("text/event-stream")) r.destroy();
    });
    r.on("error", err => { if (!r.destroyed) reject(err); });
    if (body !== undefined) r.write(body);
    r.end();
  });
}

async function fleet() {
  const dir = mkdtempSync(join(tmpdir(), "agend-1373-"));
  tempDirs.push(dir);
  const fm = new FleetManager(dir);
  fleets.push(fm);
  const quiet = () => {};
  fm.logger = { info: quiet, warn: quiet, error: quiet, debug: quiet, trace: quiet, fatal: quiet, child: () => fm.logger } as unknown as typeof fm.logger;
  vi.spyOn(fm, "notifyFleetError").mockImplementation(() => true);
  // /view's reads need the session (the case #1367's public link forces); the usage panel off, so its route answers
  // 404 behind the gate instead of asking a provider anything.
  (fm as unknown as { fleetConfig: unknown }).fleetConfig = {
    instances: { alpha: { working_directory: "/tmp" } }, defaults: {}, web: { view_access: "session", usage_panel: false, notify_login: false },
  };
  let clock = 1_000_000;
  (fm as unknown as { webSessions: WebSessionStore }).webSessions = new WebSessionStore({ now: () => clock });
  (fm as unknown as { initializeWebAuthTokens(): void }).initializeWebAuthTokens();
  (fm as unknown as { startHealthServer(port: number): void }).startHealthServer(0);
  await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true));
  const address = ((fm as unknown as { healthServer: Server }).healthServer).address();
  if (!address || typeof address === "string") throw new Error("missing TCP address");
  const port = address.port, origin = `http://127.0.0.1:${port}`;
  const login = await hit(port, "POST", "/auth/login", { "content-type": "application/json", origin }, JSON.stringify({ code: fm.issueDashboardLogin()!.display }));
  expect(login.status).toBe(200);
  const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  const get = (path: string, extra: Record<string, string> = {}) => hit(port, "GET", path, { cookie, ...extra });
  return {
    get,
    /** Move the clock forward to `ms` after sign-in. */
    at: (ms: number) => { expect(1_000_000 + ms).toBeGreaterThanOrEqual(clock); clock = 1_000_000 + ms; },
    /** Whether the session still opens a gated route — asked passively, so asking does not keep it alive. */
    alive: async () => (await get("/ui/poll")).status === 200,
  };
}

/** Each timer read, as the page makes it. A pane of an instance that does not exist: answered behind the gate, no tmux. */
const PASSIVE: Array<[string, string]> = [
  ["/ui/poll", "/ui/poll?after="],
  ["/ui/events", "/ui/events"],
  ["/api/pane/<instance>", "/api/pane/ghost"],
  ["/api/profiles", "/api/profiles"],
  ["/api/ai-usage", "/api/ai-usage"],
];

describe("a session with only passive traffic ends at the 2-hour idle limit (#1373)", () => {
  it.each(PASSIVE)("%s every few minutes does not keep it alive", async (_label, path) => {
    const f = await fleet();
    for (let t = 5 * MINUTE; t < 2 * HOUR; t += 5 * MINUTE) {
      f.at(t);
      expect((await f.get(path)).status, `${path} at ${t / MINUTE} min`).not.toBe(401);   // still authorized…
    }
    f.at(2 * HOUR);                                                                         // …but none of it was use
    expect(await f.alive()).toBe(false);
  });

  it("all of them together, as an open /view and dashboard tab make them, do not either", async () => {
    const f = await fleet();
    for (let t = MINUTE; t < 2 * HOUR; t += MINUTE) {
      f.at(t);
      for (const [, path] of PASSIVE) expect((await f.get(path)).status, path).not.toBe(401);
    }
    f.at(2 * HOUR);
    expect(await f.alive()).toBe(false);
  });
});

describe("the person still counts, and the absolute cap is unchanged", () => {
  it("one real action (opening /view) restarts the 2-hour idle window from that moment", async () => {
    const f = await fleet();
    f.at(2 * HOUR - MINUTE);
    expect((await f.get("/view", { accept: "text/html" })).status).toBe(200);
    f.at(2 * HOUR + MINUTE);
    expect(await f.alive(), "past the first window: the action extended it").toBe(true);
    f.at(4 * HOUR - 2 * MINUTE);
    expect(await f.alive()).toBe(true);
    f.at(4 * HOUR - MINUTE);
    expect(await f.alive(), "two hours after the action").toBe(false);
  });

  it("a chat's history and a dashboard page load are actions too", async () => {
    const f = await fleet();
    f.at(HOUR + 59 * MINUTE);
    expect((await f.get("/ui", { accept: "text/html" })).status).toBe(200);
    f.at(3 * HOUR + 58 * MINUTE);
    expect((await f.get("/ui/history?instance=alpha&limit=200")).status).toBe(200);   // as the dashboard asks when a chat opens
    f.at(5 * HOUR + 57 * MINUTE);
    expect(await f.alive()).toBe(true);
  });

  it("real use every hour still ends at 12 hours after sign-in", async () => {
    const f = await fleet();
    for (let t = HOUR; t < 12 * HOUR; t += HOUR) {
      f.at(t);
      expect((await f.get("/view", { accept: "text/html" })).status, `${t / HOUR} h`).toBe(200);
    }
    f.at(12 * HOUR - MINUTE);
    expect(await f.alive()).toBe(true);
    f.at(12 * HOUR);
    expect(await f.alive()).toBe(false);
  });
});
