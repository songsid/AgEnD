/**
 * M-3293 (#4119, the user's addition): "Tell" — an Office pat or feed a person chose to tell an agent about rides the
 * agent's NEXT real message in the existing `[Recent reactions: …]` line, never a turn of its own, never a wake.
 * - EventLog.addOfficeReaction: queued as message "office"; the summary reads "[Office] alex patted your head ×3, bo gave
 *   you a snack" after the messages' reactions; at most OFFICE_TELL_CAP pending a person and kind; a name cut to 40; the
 *   Office part cut to 200 characters; consumed like any reaction.
 * - POST /ui/office-tell: an admin's session (the Office is an admin's; over the public link too, as the archive's reads) —
 *   a bad body 400, an unknown instance 404, a guest or a read-only session 403, no CSRF refused; the public link's
 *   route list lets it through as it lets /ui/send (the handler's admission applies there).
 */
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/event-log.js";
import { WebSessionStore, csrfTokenFor, tokenEpoch } from "../src/web-session.js";
import { handleWebRequest } from "../src/web-api.js";
import { isPublicWebRoute } from "../src/public-web-gateway.js";

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise<void>((r) => s.close(() => r())); }
});
const log = () => { const d = mkdtempSync(join(tmpdir(), "office-tell-")); dirs.push(d); return new EventLog(join(d, "events.db")); };

describe("the reactions queue", () => {
  it("pats and feeds read as one [Office] part after the messages' reactions; ×N per person and kind", () => {
    const e = log();
    e.addReaction("atlas", "msg-1", "sam", "👍");
    for (let i = 0; i < 3; i++) expect(e.addOfficeReaction("atlas", "alex", "pat")).toBe(true);
    e.addOfficeReaction("atlas", "bo", "feed");
    expect(e.pendingReactions("atlas")!.summary).toBe("msg msg-1: 👍 from sam | [Office] alex patted your head ×3, bo gave you a snack");
    expect(e.pendingReactions("quill")).toBeNull();                      // another agent: nothing
  });
  it("only Office rows: the line alone; consumed like any reaction (then nothing)", () => {
    const e = log();
    e.addOfficeReaction("atlas", "alex", "feed");
    const p = e.pendingReactions("atlas")!;
    expect(p.summary).toBe("[Office] alex gave you a snack");
    e.markReactionsConsumed("atlas", p.maxId);
    expect(e.pendingReactions("atlas")).toBeNull();
  });
  it("capped: at most OFFICE_TELL_CAP pending a person and kind (more are not stored); a new batch after consuming", () => {
    const e = log();
    const stored = Array.from({ length: EventLog.OFFICE_TELL_CAP + 5 }, () => e.addOfficeReaction("atlas", "alex", "pat"));
    expect(stored.filter(Boolean).length).toBe(EventLog.OFFICE_TELL_CAP);
    expect(e.pendingReactions("atlas")!.summary).toBe(`[Office] alex patted your head ×${EventLog.OFFICE_TELL_CAP}`);
    expect(e.addOfficeReaction("atlas", "alex", "feed")).toBe(true);       // the other kind has its own cap
    e.markReactionsConsumed("atlas", e.pendingReactions("atlas")!.maxId);
    expect(e.addOfficeReaction("atlas", "alex", "pat")).toBe(true);
  });
  it("a long name is cut to OFFICE_NAME_MAX; the Office part to OFFICE_LINE_MAX characters, ending in …", () => {
    const e = log();
    e.addOfficeReaction("atlas", "n".repeat(90), "pat");
    for (let i = 0; i < 12; i++) e.addOfficeReaction("atlas", `person-${i}-${"x".repeat(20)}`, "feed");
    const s = e.pendingReactions("atlas")!.summary;
    expect(s.startsWith(`[Office] ${"n".repeat(EventLog.OFFICE_NAME_MAX)} patted`)).toBe(true);
    expect([...s].length).toBe(EventLog.OFFICE_LINE_MAX);
    expect(s.endsWith("…")).toBe(true);
  });
});

async function rig() {
  const token = "a".repeat(48), sessions = new WebSessionStore();
  const admin = sessions.create({ tier: "admin", surface: "local", label: "admin", tokenEpoch: tokenEpoch(token) });
  const told: any[] = [];
  const ctx: any = { webToken: token, webSessions: sessions, fleetConfig: { instances: { atlas: { working_directory: "/w" } } }, instanceIpcClients: new Map([["atlas", {}]]),
    officeTell: (instance: string, person: string, kind: string) => { told.push({ instance, person, kind }); return true; },
    logger: { error() {}, info() {}, warn() {}, debug() {} } };
  const s = createServer((req, res) => { handleWebRequest(req, res, new URL(req.url!, `http://${req.headers.host}`), ctx); });
  servers.push(s); s.listen(0, "127.0.0.1"); await once(s, "listening");
  const base = `http://127.0.0.1:${(s.address() as any).port}`;
  const as = (sessionId: string, extra: Record<string, string> = {}) => (body: unknown) => fetch(base + "/ui/office-tell", { method: "POST", body: JSON.stringify(body),
    headers: { "content-type": "application/json", cookie: `agend_session=${sessionId}`, origin: base, "x-agend-csrf": csrfTokenFor(sessionId), ...extra } });
  return { ctx, told, sessions, token, post: as(admin.sessionId), as };
}

describe("POST /ui/office-tell", () => {
  it("an admin's pat or feed is queued for the agent, under the person's name", async () => {
    const r = await rig();
    const a = await r.post({ instance: "atlas", kind: "pat" });
    expect([a.status, await a.json()]).toEqual([200, { queued: true }]);
    await r.post({ instance: "atlas", kind: "feed" });
    expect(r.told.map((t: any) => [t.instance, t.kind])).toEqual([["atlas", "pat"], ["atlas", "feed"]]);
    expect(typeof r.told[0].person).toBe("string");
    expect(r.told[0].person.length).toBeGreaterThan(0);
  });
  it("refused: a bad kind or body (400), an unknown instance (404), no CSRF, a guest, a read-only session", async () => {
    const r = await rig();
    expect((await r.post({ instance: "atlas", kind: "poke" })).status).toBe(400);
    expect((await r.post({ instance: "atlas" })).status).toBe(400);
    expect((await r.post({ instance: "../x", kind: "pat" })).status).toBe(400);
    expect((await r.post({ instance: "nobody", kind: "pat" })).status).toBe(404);
    const admin = r.sessions.list(undefined, () => true)[0] as any;
    expect((await r.as(admin.sessionId ?? "", { "x-agend-csrf": "nope" })({ instance: "atlas", kind: "pat" })).status).toBeGreaterThanOrEqual(400);
    const guest = r.sessions.create({ tier: "guest", surface: "local", label: "g", tokenEpoch: tokenEpoch(r.token), owner: { adapterId: "telegram", userId: "7" } });
    const read = r.sessions.create({ tier: "read", surface: "local", label: "r", tokenEpoch: tokenEpoch(r.token) });
    for (const who of [guest, read]) expect((await r.as(who.sessionId)({ instance: "atlas", kind: "pat" })).status, who.record.tier).toBeGreaterThanOrEqual(403);
    expect(r.told).toEqual([]);
  });
  it("the public link lets it through as it lets /ui/send (the handler's own checks apply there)", () => {
    expect(isPublicWebRoute("POST", "/ui/office-tell")).toBe(isPublicWebRoute("POST", "/ui/send"));
    expect(isPublicWebRoute("POST", "/ui/office-tell")).toBe(true);
    expect(isPublicWebRoute("GET", "/ui/office-tell")).toBe(false);
  });
});
