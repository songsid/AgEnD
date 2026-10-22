/**
 * #2293 PR 1: who may search (an admin: the header token or an admin session — never the public link, never a guest),
 * what GET /ui/search and /ui/search/context take and answer, and where the fleet feeds the index: cross-instance sends
 * and broadcasts (the same doc the outbox backfill makes), Task Board writes, web.search in fleet.yaml.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleWebRequest } from "../src/web-api.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { bindGuestRequest, guestRouteDecision } from "../src/web-guest-access.js";
import { isPublicWebRoute } from "../src/public-web-gateway.js";
import { WebSessionStore, tokenEpoch } from "../src/web-session.js";
import { WebChatHistory } from "../src/web-chat-history.js";
import { outboundHandlers } from "../src/outbound-handlers.js";
import { SchedulerDb } from "../src/scheduler/db.js";
import { validateFleetConfig } from "../src/config-validator.js";
import { xmsgDoc, xmsgFromOutbox } from "../src/search/search-docs.js";
import type { SearchFilters } from "../src/search/search-store.js";

const X = "a".repeat(32), ORIGIN = "https://sample.trycloudflare.com", TOKEN = "c".repeat(48);
const settle = () => new Promise(r => setTimeout(r, 0));
const dirs: string[] = [];
afterEach(() => { dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); });

interface Opts { publicLink?: boolean; tier?: "admin" | "read" | "guest"; header?: boolean; web?: Record<string, unknown>; index?: unknown; visibility?: unknown; person?: unknown; history?: WebChatHistory }
function fakeIndex(answer: (f: SearchFilters) => unknown = () => ({ hits: [], limited: false })) {
  let release: (() => void) | null = null, held = false;
  const index = {
    calls: [] as SearchFilters[],
    hold() { held = true; },
    release() { release?.(); },
    status: vi.fn(() => "ready"),
    query: vi.fn((f: SearchFilters) => {
      index.calls.push(f);
      const v = { ok: true, value: answer(f), building: false };
      return held ? new Promise(r => { release = () => r(v); }) : Promise.resolve(v);
    }),
    context: vi.fn(async (key: string) => ({ ok: true, building: false, value: key === "missing" ? null : {
      doc: key.startsWith("xmsg") ? { key, source: "xmsg", instance: "a", peer: "h", text: "x" } : { key, source: "chat", instance: "dev", peer: null, text: "x" }, before: [], after: [] } })),
  };
  return index;
}
function get(url: string, o: Opts = {}) {
  const sessions = new WebSessionStore();
  const tier = o.tier ?? "admin";
  const sid = sessions.create({ tier, surface: o.publicLink ? "gateway" : "local", label: "phone", tokenEpoch: tokenEpoch(TOKEN), ...(o.publicLink ? { exposureId: X } : {}),
    ...(tier === "guest" ? { owner: { adapterId: "discord", userId: "9" } } : {}) }).sessionId as string;
  const cookie = o.publicLink ? `__Host-agend_session=${sid}` : `agend_session=${sid}`;
  const headers: Record<string, string> = { host: o.publicLink ? "sample.trycloudflare.com" : "127.0.0.1:19280", ...(o.header ? { "x-agend-token": TOKEN } : { cookie }) };
  const req = Object.assign(new EventEmitter(), { method: "GET", url, headers, destroy: vi.fn() });
  let status = 0, body = "";
  const res = { destroyed: false, headersSent: false, setHeader: () => {}, writeHead: (code: number) => { status = code; }, end: (text = "") => { body = String(text); }, destroy: vi.fn() };
  if (o.publicLink) bindGatewayRequest(req, { surface: "gateway", exposureId: X, expectedOrigin: ORIGIN, isCurrent: () => true });
  if (tier === "guest") bindGuestRequest(req, { owner: { adapterId: "discord", userId: "9" }, scope: () => new Set(["dev"]) } as never);
  const index = o.index === undefined ? fakeIndex() : o.index;
  const ctx = {
    webToken: TOKEN, webSessions: sessions, fleetConfig: { instances: {}, teams: { ops: { members: ["a", "b"] } }, ...(o.web ? { web: o.web } : {}) },
    searchIndex: index, searchVisibility: () => o.visibility ?? { hidden: [] }, webChatHistory: o.history,
    ...(o.person ? { webPerson: () => o.person } : {}),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
  expect(handleWebRequest(req as never, res as never, new URL(url, o.publicLink ? ORIGIN : "http://127.0.0.1:19280"), ctx as never)).toBe(true);
  return { status: () => status, json: () => JSON.parse(body || "null"), index: index as ReturnType<typeof fakeIndex>, sessions };
}

describe("GET /ui/search: who may search", () => {
  it("an admin session or the header token: yes", async () => {
    for (const o of [{}, { header: true }]) {
      const r = get("/ui/search?q=nginx", o); await settle();
      expect([r.status(), r.json()]).toEqual([200, { hits: [], limited: false, building: false }]);
    }
  });
  it("#2478: the public link — an admin session searches there too (on its gateway's list, by default)", async () => {
    expect([isPublicWebRoute("GET", "/ui/search"), isPublicWebRoute("GET", "/ui/search/context"), isPublicWebRoute("POST", "/ui/search")]).toEqual([true, true, false]);
    for (const web of [undefined, { search: { public_link: true } }]) {
      const r = get("/ui/search?q=nginx", { publicLink: true, ...(web ? { web } : {}) }); await settle();
      expect([r.status(), r.json(), r.index.query.mock.calls.length], JSON.stringify(web)).toEqual([200, { hits: [], limited: false, building: false }, 1]);
      const c = get("/ui/search/context?key=chat:dev:b-1", { publicLink: true, ...(web ? { web } : {}) }); await settle();
      expect([c.status(), c.index.context.mock.calls.length]).toEqual([200, 1]);
    }
    const read = get("/ui/search?q=nginx", { publicLink: true, tier: "read" }); await settle();
    expect([read.status(), read.index.query.mock.calls.length], "a read-only session over the link: still admins only").toEqual([401, 0]);
  });
  it("#2478: web.search.public_link: false keeps it off the public link — 404 there, nothing searched; this machine unchanged", async () => {
    for (const path of ["/ui/search?q=nginx", "/ui/search/context?key=chat:dev:b-1"]) {
      const r = get(path, { publicLink: true, web: { search: { public_link: false } } }); await settle();
      expect([r.status(), r.json().error, r.index.query.mock.calls.length + r.index.context.mock.calls.length]).toEqual([404, "search_not_over_public_link", 0]);
    }
    const local = get("/ui/search?q=nginx", { web: { search: { public_link: false } } }); await settle();
    expect(local.status()).toBe(200);
    // web.search.enabled: false is off everywhere, the public link included.
    const off = get("/ui/search?q=nginx", { publicLink: true, web: { search: { enabled: false } } }); await settle();
    expect([off.status(), off.json().error]).toEqual([404, "search_unavailable"]);
  });
  it("#2478: turned off over the link while a search runs — nothing sent", async () => {
    const web: Record<string, unknown> = {};
    const held = fakeIndex(); held.hold();
    const r = get("/ui/search?q=x", { publicLink: true, index: held, web });
    web.search = { public_link: false };
    held.release(); await settle(); await settle();
    expect([r.status(), r.json().error]).toEqual([404, "search_not_over_public_link"]);
  });
  it("a guest: 403 at the gate every request passes (not on GUEST_ROUTES), and again in the handler", async () => {
    for (const q of ["/ui/search?q=x", "/ui/search/context?key=k"]) {
      expect(guestRouteDecision("GET", new URL(q, ORIGIN), new Set(["dev"]))).toEqual({ kind: "deny", status: 403, error: "guest_forbidden" });
    }
    const r = get("/ui/search?q=nginx", { tier: "guest" }); await settle();
    expect([r.status(), r.index.query.mock.calls.length]).toEqual([403, 0]);
  });
  it("a read-only session: 401 — admins only", async () => {
    const r = get("/ui/search?q=nginx", { tier: "read" }); await settle();
    expect([r.status(), r.index.query.mock.calls.length]).toEqual([401, 0]);
  });
  it("web.search.enabled: false, no index, or an index that cannot open: 404 search_unavailable", async () => {
    const off = get("/ui/search?q=x", { web: { search: { enabled: false } } }); await settle();
    const none = get("/ui/search?q=x", { index: null }); await settle();
    const broken = fakeIndex(); broken.status.mockReturnValue("unavailable");
    const dead = get("/ui/search?q=x", { index: broken }); await settle();
    expect([off, none, dead].map(r => [r.status(), r.json().error])).toEqual([[404, "search_unavailable"], [404, "search_unavailable"], [404, "search_unavailable"]]);
  });
  it("held while it searches: signed out, or the switch turned off, meanwhile — nothing sent", async () => {
    const out = fakeIndex(); out.hold();
    const a = get("/ui/search?q=x", { index: out });
    const h = a.sessions.list(undefined, () => true)[0]!.handle; a.sessions.revokeByHandle(h);
    out.release(); await settle(); await settle();
    expect(a.status()).toBe(401);
    const web: Record<string, unknown> = {};
    const off = fakeIndex(); off.hold();
    const b = get("/ui/search?q=x", { index: off, web });
    web.search = { enabled: false };
    off.release(); await settle(); await settle();
    expect([b.status(), b.json().error]).toEqual([404, "search_unavailable"]);
  });
});

describe("GET /ui/search: what it takes and answers", () => {
  it("q, instance, team (its members), source, since/until, limit become the filters; hidden names always go with them", async () => {
    const r = get("/ui/search?q=%20nginx%20&instance=dev&team=ops&source=chat&source=task&since=100&until=200&limit=20", { visibility: { hidden: ["h"] } }); await settle();
    expect(r.index.calls[0]).toEqual({ q: "nginx", limit: 20, instances: ["dev", "a", "b"], sources: ["chat", "task"], since: 100, until: 200, hidden: ["h"] });
    const among = get("/ui/search?q=x", { visibility: { among: ["a"] } }); await settle();
    expect(among.index.calls[0]).toEqual({ q: "x", limit: 50, xmsgAmong: ["a"] });
  });
  it("bad input: 400, nothing searched", async () => {
    for (const q of ["", "?q=", "?q=%20%20", `?q=${"x".repeat(201)}`, "?q=x&source=mail", "?q=x&since=-1", "?q=x&until=abc", "?q=x&limit=0", "?q=x&limit=201", "?q=x&team=nope", "?q=x&team=__proto__", "?q=x&instance=dev&team=constructor"]) {
      const r = get(`/ui/search${q}`); await settle();
      expect([q, r.status(), r.index.query.mock.calls.length]).toEqual([q, 400, 0]);
    }
  });
  it("mine=1: the person's own account key (the operator: web:operator)", async () => {
    const bound = get("/ui/search?q=x&mine=1", { person: { voterKey: "discord:42" } }); await settle();
    expect(bound.index.calls[0]!.mine).toEqual(["discord:42"]);
    const operator = get("/ui/search?q=x&mine=1"); await settle();
    expect(operator.index.calls[0]!.mine).toEqual(["web:operator"]);
  });
  it("a chat hit says whether its row is still in the history (live: opens in place) or only in the index", async () => {
    const history = new WebChatHistory({ boot: "b1" });
    const kept = history.record({ instance: "dev", sender: "han", text: "nginx", ts: new Date().toISOString(), role: "user" });
    const index = fakeIndex(() => ({ limited: false, hits: [
      { key: `chat:dev:b1-${kept.id}`, source: "chat", instance: "dev", ref: { boot: "b1", id: kept.id } },
      { key: "chat:dev:old-3", source: "chat", instance: "dev", ref: { boot: "old", id: 3 } },
      { key: "task:t", source: "task", instance: "dev", ref: { taskId: "t" } },
    ] }));
    const r = get("/ui/search?q=nginx", { index, history }); await settle();
    expect(r.json().hits.map((h: any) => h.live)).toEqual([true, false, undefined]);
  });
  it("held while it searches: a name hidden meanwhile is left out of the answer (per instance or by default); unchanged: kept", async () => {
    const answer = () => ({ limited: false, hits: [
      { key: "xmsg:1:h", source: "xmsg", instance: "a", peer: "h", ref: {} },
      { key: "task:t", source: "task", instance: "a", peer: null, ref: {} },
    ] });
    for (const [after, keys] of [[{ hidden: ["h"] }, ["task:t"]], [{ among: ["a"] }, ["task:t"]], [{ hidden: [] }, ["xmsg:1:h", "task:t"]], [{ among: ["a", "h"] }, ["xmsg:1:h", "task:t"]]] as const) {
      const index = fakeIndex(answer); index.hold();
      const o: Opts = { index, visibility: { hidden: [] } };
      const r = get("/ui/search?q=x", o);
      o.visibility = after;
      index.release(); await settle(); await settle();
      expect([JSON.stringify(after), r.status(), r.json().hits.map((h: any) => h.key)]).toEqual([JSON.stringify(after), 200, keys]);
    }
  });
  it("context: by key; a message to or from a hidden name is not found; an unknown key 404; no key 400", async () => {
    const ok = get("/ui/search/context?key=chat:dev:b-1"); await settle();
    expect([ok.status(), ok.json().doc.key]).toEqual([200, "chat:dev:b-1"]);
    const hidden = get("/ui/search/context?key=xmsg:1:h", { visibility: { hidden: ["h"] } }); await settle();
    const missing = get("/ui/search/context?key=missing"); await settle();
    const none = get("/ui/search/context"); await settle();
    expect([hidden.status(), missing.status(), none.status()]).toEqual([404, 404, 400]);
  });
  it("the index timed out or is busy: 503; it stopped: 404", async () => {
    for (const [reason, status] of [["timeout", 503], ["busy", 503], ["unavailable", 404]] as const) {
      const index = fakeIndex(); index.query.mockResolvedValueOnce({ ok: false, reason } as never);
      const r = get("/ui/search?q=x", { index }); await settle();
      expect([r.status(), r.json().error]).toEqual([status, `search_${reason}`]);
    }
  });
});

function outboundCtx(indexed: unknown[], admitted: unknown[]) {
  return {
    fleetConfig: { defaults: {}, instances: { sender: {}, t1: {}, t2: {} } },
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    instanceIpcClients: new Map([["t1", { connected: true, send: vi.fn() }], ["t2", { connected: true, send: vi.fn() }]]),
    sessionRegistry: new Map(),
    lifecycle: { daemons: new Map(), isPaused: vi.fn(() => false) },
    classicChannels: null,
    eventLog: { logActivity: vi.fn(), insert: vi.fn() },
    deliverToInstance: vi.fn(async () => {}),
    notifyInstanceTopic: vi.fn(() => true),
    lastActivityMs: vi.fn(() => 0),
    admitDurableDelivery: vi.fn((input: any) => { admitted.push(input); return { deliveryId: `d${admitted.length}`, state: "queued", duplicate: false }; }),
    indexCrossInstance: (r: unknown) => indexed.push(r),
  } as any;
}
const meta = { instanceName: "sender", requestId: 1, fleetRequestId: undefined, senderSessionName: undefined, operationId: "op-1" };

describe("the fleet feeds the index", () => {
  it("send_to_instance: indexed once, as the outbox backfill would index it — never forwards, the directory or the branch", async () => {
    const indexed: any[] = [], admitted: any[] = [];
    await outboundHandlers.get("send_to_instance")!(outboundCtx(indexed, admitted), {
      instance_name: "t1", message: "please fix nginx", request_kind: "task", task_summary: "nginx", working_directory: "/secret/dir", branch: "secret-branch",
    }, () => {}, meta as never);
    expect(indexed).toHaveLength(1);
    expect(JSON.stringify(indexed[0])).not.toMatch(/secret/);
    const live = xmsgDoc(indexed[0])!;
    const backfilled = xmsgDoc(xmsgFromOutbox(admitted[0].targetSession ?? admitted[0].targetInstance, "2026-01-01T00:00:00.000Z", JSON.stringify(admitted[0].payload), admitted[0].kind)!)!;
    expect(live).toEqual(backfilled);
    expect(live).toMatchObject({ instance: "sender", peer: "t1", role: "task", text: "nginx\nplease fix nginx" });
  });
  it("send_to_instance admitted before (a retried call): not indexed again", async () => {
    const indexed: any[] = [], admitted: any[] = [];
    const ctx = outboundCtx(indexed, admitted);
    ctx.admitDurableDelivery = vi.fn(() => ({ deliveryId: "d1", state: "queued", duplicate: true, kind: "fleet_inbound" }));
    await outboundHandlers.get("send_to_instance")!(ctx, { instance_name: "t1", message: "again" }, () => {}, meta as never);
    expect(indexed).toEqual([]);
  });
  it("broadcast: one doc per target, each under that target's own message id — the same as the outbox's row", async () => {
    const indexed: any[] = [], admitted: any[] = [];
    let clock = Date.UTC(2026, 9, 1);
    const tick = vi.spyOn(Date, "now").mockImplementation(() => clock++);
    await outboundHandlers.get("broadcast")!(outboundCtx(indexed, admitted), { message: "nginx for all", targets: ["t1", "t2"] }, () => {}, meta as never);
    expect(indexed.map(r => r.to)).toEqual(["t1", "t2"]);
    for (const [i, a] of admitted.entries()) {
      const backfilled = xmsgDoc(xmsgFromOutbox(a.targetSession ?? a.targetInstance, "2026-01-01T00:00:00.000Z", JSON.stringify(a.payload), a.kind)!)!;
      expect(xmsgDoc(indexed[i])).toEqual(backfilled);
      expect(backfilled.role).toBe("broadcast");
    }
    tick.mockRestore();
  });
  /** The outbox's admission as it decides duplicates: one row per operation and target; a retry gets the first. */
  function admissions() {
    const rows = new Map<string, any>();
    const admit = vi.fn((input: any) => {
      const k = `${input.operationId}\u0000${input.targetSession}`;
      const duplicate = rows.has(k);
      if (!duplicate) rows.set(k, input);
      return { deliveryId: k, state: "queued", duplicate };
    });
    const backfilled = () => [...rows.values()].map(a => xmsgDoc(xmsgFromOutbox(a.targetSession, "2026-01-01T00:00:00.000Z", JSON.stringify(a.payload), a.kind)!)!);
    return { admit, backfilled };
  }
  it("broadcast retried with the same operation: indexed once, as the outbox's one row — not under the retry's new id", async () => {
    const indexed: any[] = [];
    const { admit, backfilled } = admissions();
    const ctx = outboundCtx(indexed, []); ctx.admitDurableDelivery = admit;
    let clock = Date.UTC(2026, 9, 1);
    const tick = vi.spyOn(Date, "now").mockImplementation(() => clock++);
    for (let i = 0; i < 2; i++) await outboundHandlers.get("broadcast")!(ctx, { message: "nginx for all", targets: ["t1", "t2"] }, () => {}, meta as never);
    tick.mockRestore();
    expect(admit).toHaveBeenCalledTimes(4);
    expect(backfilled()).toHaveLength(2);
    expect(indexed.map(r => xmsgDoc(r))).toEqual(backfilled());
  });
  it("two broadcasts in the same millisecond: different ids, nothing overwritten; one broadcast's targets share its id", async () => {
    const indexed: any[] = [];
    const { admit, backfilled } = admissions();
    const ctx = outboundCtx(indexed, []); ctx.admitDurableDelivery = admit;
    const frozen = vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 9, 1));
    await outboundHandlers.get("broadcast")!(ctx, { message: "first", targets: ["t1", "t2"] }, () => {}, meta as never);
    await outboundHandlers.get("broadcast")!(ctx, { message: "second", targets: ["t1", "t2"] }, () => {}, { ...meta, operationId: "op-2" } as never);
    frozen.mockRestore();
    const docs = indexed.map(r => xmsgDoc(r)!);
    expect(new Set(docs.map(d => d.key)).size).toBe(4);
    expect(docs).toEqual(backfilled());
    expect(indexed[0].messageId).toBe(indexed[1].messageId);
    expect(indexed[0].messageId).not.toBe(indexed[2].messageId);
    expect(indexed[0].messageId).toMatch(/^bcast-\d+-[0-9a-z]{1,6}$/);
  });
  it("Task Board: every create and change (claim and done included) reaches onTaskChange after the write; a throwing listener fails nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "search-tasks-")); dirs.push(dir);
    const db = new SchedulerDb(join(dir, "scheduler.db"));
    const seen: string[] = [];
    db.onTaskChange = t => seen.push(`${t.status}:${t.title}`);
    const dev = { kind: "instance", name: "dev" } as const;
    const t = db.createTask({ title: "nginx", created_by: "lead" });
    db.claimTask(t.id, "dev", dev);
    db.completeTask(t.id, "done it", dev);
    db.onTaskChange = () => { throw new Error("listener"); };
    expect(() => db.updateTask(t.id, { priority: "high" }, dev)).not.toThrow();
    // The board's own writes (the dashboard's Task Board), not only the task tool's: a card created and edited there.
    db.onTaskChange = t => seen.push(`${t.status}:${t.title}`);
    const { cards } = db.board.createCards({ kind: "person", name: "han" } as never, { cards: [{ title: "board card" } as never] });
    db.board.updateCard({ kind: "person", name: "han" } as never, cards[0]!.code ?? cards[0]!.uuid, { title: "board card renamed" } as never);
    db.close();
    expect(seen).toEqual(["open:nginx", "claimed:nginx", "done:nginx", "open:board card", "open:board card renamed"]);
  });
  it("fleet.yaml web.search: enabled a boolean, retention_days an integer 1–3650, unknown keys warned", () => {
    const web = (p: string) => p.startsWith("web.");
    const paths = (w: unknown) => { const r = validateFleetConfig({ instances: {}, web: w } as never); return [r.errors.map(e => e.path).filter(web), r.warnings.map(x => x.path).filter(web)]; };
    expect(paths({ search: { enabled: true, retention_days: 30 } })).toEqual([[], []]);
    expect(paths({ search: "on" })[0]).toContain("web.search");
    expect(paths({ search: { enabled: "yes" } })[0]).toContain("web.search.enabled");
    for (const bad of [0, 3651, 1.5, "90"]) expect(paths({ search: { retention_days: bad } })[0]).toContain("web.search.retention_days");
    expect(paths({ search: { retension_days: 9 } })[1]).toContain("web.search.retension_days");
  });
});
