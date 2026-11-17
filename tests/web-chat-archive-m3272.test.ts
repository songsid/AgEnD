/**
 * M-3272 (the user, 2026-11-17: web chat scroll-back), the host's half: messages leaving an agent's 500-message web chat
 * window are appended to its archive (web-chat-archive.ts) instead of being dropped; the page reads older, newer and
 * around pages of it (GET /ui/history/older | newer | around: an admin's, over the public link too; never a guest's or
 * a read-only session's); `web.chat_archive.retention_days` (unset or 0: keep everything) drops whole months.
 */
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebChatArchive } from "../src/web-chat-archive.js";
import { WebChatHistory, type WebChatMessage } from "../src/web-chat-history.js";
import { WebSessionStore, tokenEpoch, csrfTokenFor } from "../src/web-session.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { handleWebRequest } from "../src/web-api.js";
import { isPublicWebRoute } from "../src/public-web-gateway.js";
import { validateFleetConfig } from "../src/config-validator.js";

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "chat-archive-3272-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const log = { warn: vi.fn(), debug: vi.fn() };
const NOV = Date.UTC(2026, 10, 17, 9, 0, 0), OCT = Date.UTC(2026, 9, 10, 9, 0, 0);
const line = (n: number, extra: Record<string, unknown> = {}) => ({ key: `ab12-${n}`, boot: "ab12", id: n, instance: "alpha", role: "agent", sender: "atlas", text: `message ${n}`, ts: new Date(NOV).toISOString(), ...extra });

function archive(o: { home?: string; owner?: string | null; days?: number; now?: () => number } = {}) {
  const home = o.home ?? tmp();
  const a = new WebChatArchive({ home, ownerOf: () => (o.owner === undefined ? "dir:/w/alpha" : o.owner), retentionDays: () => o.days, logger: log, now: o.now ?? (() => NOV) });
  return { a, home, dir: join(home, "workspaces", "alpha", "web-chat-archive") };
}

describe("the archive: append-only, a month a file, read backwards a page at a time", () => {
  it("appends in order (queued), the key first on each line; one file per month; owner-only", async () => {
    const { a, dir } = archive();
    a.append("alpha", [line(1), line(2)]); a.append("alpha", [line(3)]);
    await a.flush();
    expect(readdirSync(dir).sort()).toEqual(["2026-11.jsonl", "owner"]);
    const text = readFileSync(join(dir, "2026-11.jsonl"), "utf8");
    expect(text.split("\n").filter(Boolean).map(l => l.slice(0, 18))).toEqual(['{"key":"ab12-1","b', '{"key":"ab12-2","b', '{"key":"ab12-3","b']);
    expect(readFileSync(join(dir, "owner"), "utf8")).toBe("dir:/w/alpha");
  });

  it("older: the newest page, then older than a key — across months and across read chunks (long lines), with `more`", async () => {
    let now = OCT;
    const { a } = archive({ now: () => now });
    const big = "x".repeat(9000);                                         // ~9 KB a line: pages cross the 64 KB chunks
    a.append("alpha", Array.from({ length: 30 }, (_, i) => line(i + 1, { text: big + (i + 1) })));
    await a.flush(); now = NOV;
    a.append("alpha", Array.from({ length: 30 }, (_, i) => line(i + 31, { text: big + (i + 31) })));
    await a.flush();
    const ids = (r: { lines: Array<{ key: string }> }) => r.lines.map(l => Number(l.key.split("-")[1]));
    const top = a.older("alpha", null, 10);
    expect([ids(top), top.more, top.found]).toEqual([[51, 52, 53, 54, 55, 56, 57, 58, 59, 60], true, true]);
    const across = a.older("alpha", "ab12-35", 10);                        // the page crosses into October's file
    expect([ids(across), across.more]).toEqual([[25, 26, 27, 28, 29, 30, 31, 32, 33, 34], true]);
    const first = a.older("alpha", "ab12-5", 10);
    expect([ids(first), first.more]).toEqual([[1, 2, 3, 4], false]);
    expect(a.older("alpha", "ab12-999", 10)).toEqual({ lines: [], more: false, found: false });
    expect(across.lines[0]!.text).toBe(big + 25);                         // whole lines, never cut at a chunk's edge
  });

  it("around: the key with older and newer ones; null when not archived", async () => {
    const { a } = archive();
    a.append("alpha", Array.from({ length: 20 }, (_, i) => line(i + 1)));
    await a.flush();
    const r = a.around("alpha", "ab12-10", 3, 3)!;
    expect([r.lines.map(l => l.key), r.olderMore, r.newerMore]).toEqual([["ab12-7", "ab12-8", "ab12-9", "ab12-10", "ab12-11", "ab12-12", "ab12-13"], true, true]);
    expect(a.around("alpha", "ab12-19", 2, 5)!.newerMore, "near the end: no newer left in the archive").toBe(false);
    expect(a.around("alpha", "ab12-77", 3, 3)).toBeNull();
  });

  it("another agent's archive under the name (it was removed while the fleet was down): never read; set aside on the first write", async () => {
    const home = tmp();
    const old = archive({ home, owner: "dir:/w/old" });
    old.a.append("alpha", [line(1)]); await old.a.flush();
    const now = archive({ home, owner: "dir:/w/new" });
    expect(now.a.older("alpha", null, 10).lines).toEqual([]);
    now.a.append("alpha", [line(2)]); await now.a.flush();
    expect(now.a.older("alpha", null, 10).lines.map(l => l.key)).toEqual(["ab12-2"]);
    expect(readdirSync(join(home, "workspaces", "alpha")).some(f => /^web-chat-archive\.\d+\.old$/.test(f)), "set aside, not deleted").toBe(true);
    const none = archive({ home, owner: null });                          // not configured: nothing archived, nothing read
    none.a.append("alpha", [line(3)]); await none.a.flush();
    expect(none.a.older("alpha", null, 10).lines).toEqual([]);
  });

  it("retention: whole months that ended before it go; unset or 0 keeps everything; forget removes it all", async () => {
    let now = Date.UTC(2026, 7, 5);                                       // August
    const days = { v: undefined as number | undefined };
    const home = tmp();
    const a = new WebChatArchive({ home, ownerOf: () => "dir:/w/alpha", retentionDays: () => days.v, logger: log, now: () => now });
    for (const m of [7, 8, 9, 10]) { now = Date.UTC(2026, m, 5); a.append("alpha", [line(m)]); await a.flush(); }
    expect(a.prune("alpha")).toEqual([]);
    days.v = 0; expect(a.prune("alpha")).toEqual([]);
    days.v = 40;                                                           // now 5 Nov: the cut-off is 26 Sep
    expect(a.prune("alpha").sort()).toEqual(["2026-08.jsonl"]);
    expect(readdirSync(join(home, "workspaces", "alpha", "web-chat-archive")).sort()).toEqual(["2026-09.jsonl", "2026-10.jsonl", "2026-11.jsonl", "owner"]);
    await a.forget("alpha");
    expect(existsSync(join(home, "workspaces", "alpha", "web-chat-archive"))).toBe(false);
  });
});

/** A history with a 5-message window, archiving into a scratch home. */
function history() {
  const { a, home, dir } = archive();
  const h = new WebChatHistory({ perInstance: 5, boot: "b0" });
  h.setArchive(a);
  const say = (n: number, extra: Record<string, unknown> = {}) => h.record({ instance: "alpha", sender: "atlas", text: `m${n}`, ts: new Date(NOV + n * 1000).toISOString(), ...extra } as never);
  return { h, a, home, dir, say };
}
const keys = (ms: WebChatMessage[]) => ms.map(m => `${m.boot}-${m.id}`);

describe("the history: past the window, archived — and paged back across both", () => {
  it("23 messages, a window of 5: 18 archived (not dropped); older from the window's first runs into the archive, to the start", async () => {
    const { h, a, say } = history();
    for (let n = 1; n <= 23; n++) say(n);
    await a.flush();
    expect(keys(h.list("alpha"))).toEqual(["b0-19", "b0-20", "b0-21", "b0-22", "b0-23"]);
    const p1 = h.older("alpha", "b0-21", 7)!;                           // 2 from the window, 5 from the archive
    expect([keys(p1.messages), p1.more, p1.messages.map(m => !!m.archived)]).toEqual([["b0-14", "b0-15", "b0-16", "b0-17", "b0-18", "b0-19", "b0-20"], true, [true, true, true, true, true, false, false]]);
    const p2 = h.older("alpha", "b0-14", 100)!;
    expect([keys(p2.messages).length, keys(p2.messages)[0], p2.more]).toEqual([13, "b0-1", false]);
    expect(h.older("alpha", "b0-77", 10)).toBeNull();
  });

  it("newer from an archived key runs back into the window; around a deep key centres on it", async () => {
    const { h, a, say } = history();
    for (let n = 1; n <= 23; n++) say(n);
    await a.flush();
    const nw = h.newer("alpha", "b0-15", 6)!;
    expect([keys(nw.messages), nw.more]).toEqual([["b0-16", "b0-17", "b0-18", "b0-19", "b0-20", "b0-21"], true]);
    const end = h.newer("alpha", "b0-21", 10)!;
    expect([keys(end.messages), end.more]).toEqual([["b0-22", "b0-23"], false]);
    const ar = h.around("alpha", "b0-8", 5)!;
    expect([keys(ar.messages), ar.olderMore, ar.newerMore]).toEqual([["b0-6", "b0-7", "b0-8", "b0-9", "b0-10"], true, true]);
    const inWindow = h.around("alpha", "b0-20", 5)!;
    expect([keys(inWindow.messages), inWindow.olderMore, inWindow.newerMore]).toEqual([["b0-18", "b0-19", "b0-20", "b0-21", "b0-22"], true, true]);
  });

  it("an archived reply's buttons and poll are read-only (open → expired); its files are names only (gone)", async () => {
    const { h, a, say } = history();
    const SET = "e".repeat(32);
    say(1, { role: "agent", buttons: { id: SET, labels: ["Yes", "No"], state: "open" }, attachments: [{ id: "f1", kind: "photo", name: "plan.png", size: 9, mime: "image/png" }] });
    for (let n = 2; n <= 7; n++) say(n);
    await a.flush();
    const m = h.older("alpha", "b0-2", 1)!.messages[0];
    expect([m!.buttons, m!.attachments]).toEqual([{ id: SET, labels: ["Yes", "No"], state: "expired" }, [{ gone: true, kind: "photo", name: "plan.png", size: 9, mime: "image/png" }]]);
  });

  it("no archive (as before M-3272): older past the window is nothing; an agent removed takes its archive with it", async () => {
    const plain = new WebChatHistory({ perInstance: 5, boot: "b0" });
    for (let n = 1; n <= 8; n++) plain.record({ instance: "alpha", sender: "s", text: `m${n}`, ts: new Date(NOV).toISOString() } as never);
    expect(plain.older("alpha", "b0-2", 10), "dropped: unknown").toBeNull();
    expect(plain.older("alpha", "b0-4", 10), "the window's first, nothing older kept").toEqual({ messages: [], more: false });
    const { h, a, dir, say } = history();
    for (let n = 1; n <= 8; n++) say(n);
    await a.flush();
    expect(existsSync(dir)).toBe(true);
    h.forget("alpha"); await a.flush(); await new Promise(r => setTimeout(r, 10));
    expect(existsSync(dir)).toBe(false);
  });
});

const token = "c".repeat(48), local = "http://127.0.0.1:19280", pub = "https://sample.trycloudflare.com", exposureId = "a".repeat(32);
function request(path: string, headers: Record<string, string> = {}, host = "127.0.0.1:19280") {
  const req = Object.assign(new EventEmitter(), { method: "GET", url: path, headers: { host, ...headers } as Record<string, string>, destroy: vi.fn(), socket: { destroy: vi.fn() } });
  let status = 0, body = "";
  const res = Object.assign(new EventEmitter(), { destroyed: false, headersSent: false, writableEnded: false, setHeader() {}, writeHead: (c: number) => { status = c; }, end: (t = "") => { body = String(t); }, write: () => true, destroy: vi.fn() });
  return { req, res, status: () => status, json: () => JSON.parse(body || "null") };
}
async function routes(o: { tier?: "admin" | "read" | "guest"; publicLink?: boolean } = {}) {
  const sessions = new WebSessionStore();
  const s = sessions.create({ tier: o.tier ?? "admin", surface: o.publicLink ? "gateway" : "local", label: "t", tokenEpoch: tokenEpoch(token),
    ...(o.publicLink ? { exposureId } : {}), ...(o.tier === "guest" ? { owner: { adapterId: "discord", userId: "42" } } : {}) } as never);
  const { h, a, say } = history();
  for (let n = 1; n <= 23; n++) say(n);
  await a.flush();
  const ctx = { webToken: token, webSessions: sessions, webChatHistory: h, logger: { info() {}, debug() {}, error() {}, warn() {} }, sseClients: new Set(), getUiStatus: () => ({ instances: [] }), emitSseEvent: vi.fn() } as any;
  const cookie = `${o.publicLink ? "__Host-" : ""}agend_session=${s.sessionId}`, host = o.publicLink ? "sample.trycloudflare.com" : "127.0.0.1:19280";
  const get = (path: string) => {
    const r = request(path, { cookie, "x-agend-csrf": csrfTokenFor(s.sessionId) }, host);
    if (o.publicLink) bindGatewayRequest(r.req as never, { surface: "gateway", exposureId, expectedOrigin: pub, isCurrent: () => true });
    handleWebRequest(r.req as never, r.res as never, new URL(path, local), ctx);
    return { status: r.status(), json: r.json() };
  };
  return { get };
}

describe("GET /ui/history/older | newer | around", () => {
  it("an admin: pages across the window and the archive; a bad request 400; an unknown key 404", async () => {
    const t = await routes();
    const older = t.get("/ui/history/older?instance=alpha&before=b0-19&limit=3");
    expect([older.status, keys(older.json.messages), older.json.more, older.json.messages.every((m: any) => m.archived)]).toEqual([200, ["b0-16", "b0-17", "b0-18"], true, true]);
    const newer = t.get("/ui/history/newer?instance=alpha&after=b0-17&limit=3");
    expect([newer.status, keys(newer.json.messages)]).toEqual([200, ["b0-18", "b0-19", "b0-20"]]);
    const around = t.get("/ui/history/around?instance=alpha&key=b0-3&limit=5");
    expect([around.status, keys(around.json.messages), around.json.olderMore, around.json.newerMore]).toEqual([200, ["b0-1", "b0-2", "b0-3", "b0-4", "b0-5"], false, true]);
    expect(t.get("/ui/history/older?instance=alpha&before=nope&limit=3").status).toBe(400);
    expect(t.get("/ui/history/older?instance=alpha&before=b0-1&limit=101").status).toBe(400);
    expect(t.get("/ui/history/around?instance=alpha&key=b0-999&limit=5").status).toBe(404);
  });
  it("on the public link's route list (the gateway lets them through; the handler decides who)", () => {
    expect(["older", "newer", "around"].map(r => isPublicWebRoute("GET", `/ui/history/${r}`))).toEqual([true, true, true]);
    expect([isPublicWebRoute("POST", "/ui/history/older"), isPublicWebRoute("GET", "/ui/history/other")]).toEqual([false, false]);
  });
  it("an admin over the public link too (decision 7933bf90); a read-only session and a guest: 403", async () => {
    expect((await routes({ publicLink: true })).get("/ui/history/older?instance=alpha&before=b0-19&limit=3").status).toBe(200);
    for (const tier of ["read", "guest"] as const) expect([tier, (await routes({ tier })).get("/ui/history/older?instance=alpha&before=b0-19&limit=3").status]).toEqual([tier, 403]);
  });
});

describe("the setting", () => {
  it("web.chat_archive.retention_days: a whole number 0–3650; unknown keys warned", () => {
    const FLEET = { defaults: {}, channels: [{ id: "dc", type: "discord", group_id: "G", bot_token_env: "X" }], instances: { a: { working_directory: "/tmp" } } };
    const v = (ca: unknown) => validateFleetConfig({ ...structuredClone(FLEET), web: { chat_archive: ca } } as never);
    expect([v({ retention_days: 0 }).valid, v({ retention_days: 3650 }).valid, v({ retention_days: 3651 }).valid, v({ retention_days: 1.5 }).valid, v("x").valid]).toEqual([true, true, false, false, false]);
    expect(v({ keep: true }).warnings.some(w => w.path === "web.chat_archive.keep")).toBe(true);
  });
});
