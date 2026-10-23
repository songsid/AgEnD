/**
 * #2366 (found by Prism reviewing #2365): a guest's upload is checked against the guest's scope when it starts; its body
 * then streams (up to 30 minutes, #1937). Narrowed, or revoked, while the body is still arriving, the upload used to
 * finish for an agent the guest no longer reaches. At the commit point — after the body and again after the write's own
 * finish — the guest's scope is asked again: out of scope, the upload is refused (404) and its part file removed; the
 * session ended, 401. A real FleetManager and listener, a real guest session, grants in config, a real chunked body.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("../src/logger.js", async original => {
  const silent: Record<string, unknown> = new Proxy({}, { get: (_t, key) => (key === "child" ? () => silent : key === "level" ? "silent" : () => {}) });
  return { ...await original<typeof import("../src/logger.js")>(), createLogger: () => silent };
});
// The write's finish is a wait of its own: to land a change exactly there, the scope check can be told to refuse on its
// Nth call within an upload (1: the start, 2: the body's end, 3: the write's finish). Off by default: the real check.
const refusal = { calls: 0, refuseOn: 0 };
vi.mock("../src/web-guest-access.js", async original => {
  const m = await original<typeof import("../src/web-guest-access.js")>();
  return { ...m, guestChatRefusal: (guest: Parameters<typeof m.guestChatRefusal>[0], instance: unknown) => {
    refusal.calls++;
    if (refusal.refuseOn && refusal.calls === refusal.refuseOn) return { status: 404 as const, error: "not found" };
    return m.guestChatRefusal(guest, instance);
  } };
});
import { request, type ClientRequest } from "node:http";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "agend-2366-home-"));
process.env.AGEND_HOME = home;

const { FleetManager } = await import("../src/fleet-manager.js");
const { WEB_CSRF_HEADER, WEB_SESSION_COOKIE } = await import("../src/web-auth.js");
const { csrfTokenFor, tokenEpoch } = await import("../src/web-session.js");

const ALICE = { adapterId: "discord", userId: "111111111111111111" };
const KEY = `${ALICE.adapterId}:${ALICE.userId}`;
let fm: any, port = 0, dir: string;
const inbox = (instance: string) => join(home, "workspaces", instance, "inbox");
const files = (instance: string) => (existsSync(inbox(instance)) ? readdirSync(inbox(instance)) : []);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agend-2366-fleet-"));
  writeFileSync(join(dir, "fleet.yaml"), `health_port: 0\ninstances:\n  a:\n    working_directory: ${dir}\n    backend: claude-code\n  b:\n    working_directory: ${dir}\n    backend: claude-code\n`);
  fm = new FleetManager(dir);
  const q = () => {}; fm.logger = { info: q, warn: q, error: q, debug: q, trace: q, fatal: q, child: () => fm.logger };
  fm.notifyFleetError = () => true; fm.loadConfig(join(dir, "fleet.yaml"));
  fm.lifecycle = { isPaused: () => false, hasWorkLease: () => false, daemons: new Map() };
  fm.getInstanceStatus = () => "running";
  for (const n of ["a", "b"]) fm.instanceIpcClients.set(n, { connected: true, send: () => true });   // both can take a file
  fm.worlds.set("discord", { id: "discord", adapter: { type: "discord" }, accessManager: { getMode: () => "pairing", isAllowed: () => true } });
  fm.fleetConfig.web = { guests: { enabled: true, grants: { [KEY]: { instances: ["a", "b"] } } } };
  fm.initializeWebAuthTokens(); fm.startHealthServer(0);
  await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true));
  port = (fm.healthServer.address() as { port: number }).port;
  fm.initializeWebSessions?.();
});
afterAll(async () => {
  await new Promise<void>((r) => fm.healthServer?.close(() => r()));
  rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
});

const guestSession = () => fm.webSessions.create({ tier: "guest", surface: "local", label: "guest", tokenEpoch: tokenEpoch(fm.getDashboardAccess().token!), owner: ALICE }).sessionId as string;

/** An upload whose body is held: the first chunk goes now; `finish()` sends the rest and resolves with the answer. */
function heldUpload(sid: string, instance: string) {
  let req!: ClientRequest;
  const answer = new Promise<{ status: number; body: any }>((resolve, reject) => {
    req = request({ host: "127.0.0.1", port, method: "POST", path: `/ui/upload?instance=${instance}`, headers: {
      host: `127.0.0.1:${port}`, cookie: `${WEB_SESSION_COOKIE}=${sid}`, origin: `http://127.0.0.1:${port}`, [WEB_CSRF_HEADER]: csrfTokenFor(sid),
      "content-type": "application/octet-stream", "x-agend-filename": "notes.txt", "transfer-encoding": "chunked" } }, (res) => {
      let b = ""; res.on("data", (c: Buffer) => { b += c.toString(); });
      res.on("end", () => { let body: any = null; try { body = JSON.parse(b); } catch { body = b; } resolve({ status: res.statusCode ?? 0, body }); });
    });
    req.on("error", reject);
  });
  req.write("first half of the notes, ");
  return { answer, finish: () => { req.end("and the second half.\n"); return answer; } };
}
/** The server has the body's first part: its part file is in the instance's inbox. */
const started = (instance: string) => vi.waitFor(() => expect(files(instance).some((f) => f.endsWith(".part"))).toBe(true));

describe("#2366: a guest's upload in flight follows the guest's scope at its commit point", () => {
  it("control: nothing changes while it streams — the file is stored for the agent", async () => {
    const up = heldUpload(guestSession(), "a");
    await started("a");
    const done = await up.finish();
    expect([done.status, typeof done.body.id]).toEqual([200, "string"]);
    expect(files("a").filter((f) => f.endsWith(".part"))).toEqual([]);
  });

  it("narrowed away from the agent while the body was arriving: 404, nothing stored, the part file removed", async () => {
    const before = files("b").filter((f) => !f.endsWith(".part"));
    const up = heldUpload(guestSession(), "b");
    await started("b");
    fm.fleetConfig.web.guests.grants = { [KEY]: { instances: ["a"] } };          // b taken away meanwhile
    try {
      const done = await up.finish();
      expect(done).toEqual({ status: 404, body: { error: "not found" } });
      expect(files("b").filter((f) => !before.includes(f)), "no stored file, no part file left").toEqual([]);
    } finally { fm.fleetConfig.web.guests.grants = { [KEY]: { instances: ["a", "b"] } }; }
  });

  it("guests made read-only meanwhile: 403, nothing stored", async () => {
    const before = files("a").filter((f) => !f.endsWith(".part"));
    const up = heldUpload(guestSession(), "a");
    await started("a");
    fm.fleetConfig.web.guests.chat = false;
    try {
      const done = await up.finish();
      expect(done).toEqual({ status: 403, body: { error: "guest_read_only" } });
      expect(files("a").filter((f) => !before.includes(f))).toEqual([]);
    } finally { delete fm.fleetConfig.web.guests.chat; }
  });

  it("the grant taken away altogether meanwhile: refused (the session has nothing left), nothing stored", async () => {
    const before = files("a").filter((f) => !f.endsWith(".part"));
    const up = heldUpload(guestSession(), "a");
    await started("a");
    fm.fleetConfig.web.guests.grants = {};
    try {
      const done = await up.finish();
      expect([401, 404]).toContain(done.status);
      expect(files("a").filter((f) => !before.includes(f))).toEqual([]);
    } finally { fm.fleetConfig.web.guests.grants = { [KEY]: { instances: ["a", "b"] } }; }
  });

  it("narrowed during the write's own finish (after the body's end was checked): still refused, nothing stored", async () => {
    const before = files("a").filter((f) => !f.endsWith(".part"));
    refusal.calls = 0; refusal.refuseOn = 3;                                     // passes at the start and at the end
    try {
      const up = heldUpload(guestSession(), "a");
      await started("a");
      const done = await up.finish();
      expect([done, refusal.calls]).toEqual([{ status: 404, body: { error: "not found" } }, 3]);
      expect(files("a").filter((f) => !before.includes(f))).toEqual([]);
    } finally { refusal.refuseOn = 0; }
  });

  it("the old derived access narrowed (legacy `narrow`, no grants) meanwhile: refused the same way", async () => {
    const saved = fm.fleetConfig.web.guests.grants;
    delete fm.fleetConfig.web.guests.grants;                                     // #1920's derived scope: a and b
    try {
      expect([...fm.guestScope(ALICE)].sort()).toEqual(["a", "b"]);
      const before = files("b").filter((f) => !f.endsWith(".part"));
      const up = heldUpload(guestSession(), "b");
      await started("b");
      fm.fleetConfig.web.guests.narrow = { [KEY]: ["a"] };
      const done = await up.finish();
      expect(done).toEqual({ status: 404, body: { error: "not found" } });
      expect(files("b").filter((f) => !before.includes(f))).toEqual([]);
    } finally { delete fm.fleetConfig.web.guests.narrow; fm.fleetConfig.web.guests.grants = saved; }
  });
});
