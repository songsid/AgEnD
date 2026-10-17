/**
 * #1920 (P1 for beta.4): a guest signed in through the public link (#2094) never sees an instance name out of its scope
 * in any preferences payload — the page's data-prefs and GET /ui/prefs alike. Before, the public link's branch of
 * prefsViewer dropped the guest flag: such a guest read the host's preferences unfiltered (the sidebar's order, its
 * favourites, per-instance card sizes, folded groups). An admin there, and a guest on the dashboard reached directly,
 * are the controls. POST /ui/prefs stays closed on the public link for everyone.
 * Rig: the real handlers with a fake gateway request (as public-web-auth-1367) and a real WebPrefsStore.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSessionStore, tokenEpoch } from "../src/web-session.js";
import { WebPrefsStore } from "../src/web-prefs.js";
import { handleWebRequest } from "../src/web-api.js";
import { bindGatewayRequest } from "../src/web-request-context.js";

const X = "a".repeat(32), TOKEN = "c".repeat(48), ORIGIN = "https://sample.trycloudflare.com";
const SECRET = "secret-agent", GROUP = "secret-group";
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); vi.restoreAllMocks(); });

function request(path: string, cookie: string) {
  const req = Object.assign(new EventEmitter(), { method: "GET", url: path, headers: { host: "sample.trycloudflare.com", cookie } as Record<string, string>, destroy: vi.fn() });
  let status = 0, body = "";
  const res = { destroyed: false, headersSent: false, setHeader: () => {}, writeHead: (code: number) => { status = code; }, end: (text = "") => { body = String(text); }, destroy: vi.fn() };
  return { req, res, status: () => status, body: () => body };
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "agend-1920pp-")); dirs.push(dir);
  const prefs = new WebPrefsStore(dir, { exists: (n) => n === SECRET || n === "a" });
  // The host's arrangement, naming an instance and a group a guest scoped elsewhere must never learn of.
  const written = prefs.write("operator", new Map<string, unknown>([
    ["theme", "dark"],
    ["nav.order", [{ item_type: "group", item_name: GROUP, sort_index: 0, group_name: null }, { item_type: "instance", item_name: SECRET, sort_index: 0, group_name: GROUP }]],
    ["nav.favorites", [SECRET]],
    ["nav.collapsed", [GROUP]],
    ["card.sizeByInstance", { [SECRET]: "l" }],
  ]));
  expect(written.ok).toBe(true);
  const sessions = new WebSessionStore();
  const session = (tier: "admin" | "guest", surface: "gateway" | "local") => sessions.create({ tier, surface, label: "phone", tokenEpoch: tokenEpoch(TOKEN),
    ...(surface === "gateway" ? { exposureId: X } : {}), ...(tier === "guest" ? { owner: { adapterId: "dc", userId: "111" } } : {}) }).sessionId as string;
  const ctx = { webToken: TOKEN, webSessions: sessions, webPrefs: prefs, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } };
  const get = (path: string, sid: string, publicLink: boolean) => {
    const h = request(path, publicLink ? `__Host-agend_session=${sid}` : `agend_session=${sid}`);
    if (publicLink) bindGatewayRequest(h.req, { surface: "gateway", exposureId: X, expectedOrigin: ORIGIN, isCurrent: () => true });
    expect(handleWebRequest(h.req as never, h.res as never, new URL(path, publicLink ? ORIGIN : "http://127.0.0.1:19280"), ctx as never)).toBe(true);
    return h;
  };
  return { session, get };
}
const dataPrefs = (html: string) => {
  const m = /<html[^>]*data-prefs="([^"]*)"/.exec(html);
  return m ? m[1]!.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))) : "";
};

describe("a guest through the public link: no out-of-scope name in any preferences payload", () => {
  it("GET /ui/prefs: the host's look only (theme), nothing that names an instance or group", () => {
    const f = fixture();
    const r = f.get("/ui/prefs", f.session("guest", "gateway"), true);
    expect(r.status()).toBe(200);
    expect(r.body()).not.toContain(SECRET);
    expect(r.body()).not.toContain(GROUP);
    expect(JSON.parse(r.body()).values).toEqual({ theme: "dark" });
  });
  it("the page's data-prefs: the same", () => {
    const f = fixture();
    const r = f.get("/ui", f.session("guest", "gateway"), true);
    expect(r.status()).toBe(200);
    const prefs = dataPrefs(r.body());
    expect(prefs).toContain('"theme":"dark"');
    expect(prefs).not.toContain(SECRET);
    expect(prefs).not.toContain(GROUP);
  });
  it("controls: an admin through the link reads the arrangement; a guest reached directly is filtered as before", () => {
    const f = fixture();
    expect(f.get("/ui/prefs", f.session("admin", "gateway"), true).body(), "an admin's prefs do name it (the test can tell)").toContain(SECRET);
    const local = f.get("/ui/prefs", f.session("guest", "local"), false);
    expect(local.body()).not.toContain(SECRET);
    expect(dataPrefs(f.get("/ui", f.session("guest", "local"), false).body())).not.toContain(SECRET);
  });
});
