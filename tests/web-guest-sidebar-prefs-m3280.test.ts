import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebPrefsStore } from "../src/web-prefs.js";
import { WebSessionStore, csrfTokenFor, tokenEpoch } from "../src/web-session.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { bindGuestRequest, guestStatus } from "../src/web-guest-access.js";
import { handleWebRequest } from "../src/web-api.js";

const token = "c".repeat(48), exposure = "a".repeat(32), origin = "https://fleet.example.com";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const choice = { "nav.density": "detailed", "nav.densityPhone": "compact", "nav.compactName": "instance", "nav.sort": { mode: "recent", favs: "fixed" }, "nav.filter": { q: "Beacon", status: [], cli: [] } };
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "guest-sidebar-")); dirs.push(dir);
  const prefs = new WebPrefsStore(dir, { exists: () => true }), sessions = new WebSessionStore();
  const owner = { adapterId: "discord", userId: "900000000000000099" }, person = `person:${owner.adapterId}:${owner.userId}`;
  const ctx = { webToken: token, webPrefs: prefs, webSessions: sessions, sseClients: new Set(), getUiStatus: () => ({ instances: [] }), emitSseEvent: vi.fn(), logger: { info() {}, debug() {}, warn() {}, error() {} } } as any;
  const call = async (tier: "guest" | "admin", gateway: boolean, set?: Record<string, unknown>, userId = owner.userId) => {
    const who = { ...owner, userId }, s = sessions.create({ tier, surface: gateway ? "gateway" : "local", label: "fixture", tokenEpoch: tokenEpoch(token), ...(gateway ? { exposureId: exposure } : {}), ...(tier === "guest" ? { owner: who } : {}) });
    const req = Object.assign(new EventEmitter(), { method: set ? "POST" : "GET", url: "/ui/prefs", headers: { host: gateway ? "fleet.example.com" : "127.0.0.1:19280", cookie: `${gateway ? "__Host-" : ""}agend_session=${s.sessionId}`, origin: gateway ? origin : "http://127.0.0.1:19280", "sec-fetch-site": "same-origin", "x-agend-csrf": csrfTokenFor(s.sessionId), "content-type": "application/json" }, socket: {}, destroy: vi.fn() });
    let status = 0, body = "";
    const res = Object.assign(new EventEmitter(), { destroyed: false, headersSent: false, writableEnded: false, setHeader() {}, writeHead(code: number) { status = code; }, end(text = "") { body = String(text); }, write: () => true, destroy: vi.fn() });
    if (gateway) bindGatewayRequest(req as never, { surface: "gateway", exposureId: exposure, expectedOrigin: origin, isCurrent: () => true });
    if (tier === "guest") bindGuestRequest(req, { owner: who, scope: () => new Set(["agent-alpha", "agent-beta", "shared-room"]), current: () => true });
    expect(handleWebRequest(req as never, res as never, new URL(req.url, origin), ctx)).toBe(true);
    if (set) { req.emit("data", Buffer.from(JSON.stringify({ set, person: "operator" }))); req.emit("end"); }
    await vi.waitFor(() => expect(status).not.toBe(0));
    return { status, body: JSON.parse(body) };
  };
  return { prefs, person, call, dir };
}
describe("M-3280 guest sidebar choices stay in the guest bucket", () => {
  it("saves all sidebar choices over the public link and reloads them for the same account", async () => {
    const f = fixture(); f.prefs.write("operator", new Map<string, unknown>([["nav.density", "compact"], ["nav.compactName", "nickname"]]));
    const host = f.prefs.read("operator").values;
    const written = await f.call("guest", true, choice);
    expect(written.status).toBe(200); expect(written.body.values).toMatchObject(choice);
    expect(f.prefs.readGuestOwn(f.person)).toEqual(choice);
    expect((await f.call("guest", false)).body.values).toMatchObject(choice);
    expect(new WebPrefsStore(f.dir).readGuestOwn(f.person)).toEqual(choice);
    expect(f.prefs.read("operator").values).toEqual(host);
    expect((await f.call("guest", true, undefined, "900000000000000098")).body.values).not.toHaveProperty("nav.compactName");
  });
  it("keeps admin local saves and its public-link refusal unchanged", async () => {
    const f = fixture(); expect((await f.call("admin", false, choice)).status).toBe(200);
    expect(f.prefs.read("operator").values).toMatchObject(choice);
    expect((await f.call("admin", true, { "nav.density": "compact" })).status).toBe(403);
  });
  it("does not inherit host nav choices or expose an ungranted agent in a guest preference view", async () => {
    const f = fixture(); f.prefs.write("operator", new Map<string, unknown>(Object.entries({ ...choice, "nav.favorites": ["hidden-agent"], "nav.collapsed": ["Hidden team"] })));
    const r = await f.call("guest", true);
    expect(r.status).toBe(200); expect(r.body.values).toEqual({});
    const projected = guestStatus({ instances: [{ name: "agent-alpha", display_name: "Atlas" }, { name: "shared-room", display_name: "Shared room" }, { name: "hidden-agent", display_name: "Hidden helper" }] }, new Set(["agent-alpha", "shared-room"])) as any;
    expect(projected.instances.map((x: any) => x.name)).toEqual(["agent-alpha", "shared-room"]);
  });
  it("still refuses host-only keys and out-of-scope favorites atomically", async () => {
    const f = fixture();
    expect((await f.call("guest", true, { ...choice, "nav.order": [] })).status).toBe(400);
    expect(f.prefs.readGuestOwn(f.person)).toEqual({});
    expect((await f.call("guest", true, { "nav.favorites": ["hidden-agent"] })).status).toBe(400);
  });
});
