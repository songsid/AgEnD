/**
 * #2293 PR 1: global search's index — the store (FTS5 trigram, short terms, masking, filters, retention), what each
 * source indexes (and never: forwards, paths, status lines), and the fleet's lane to the worker (batching, the backfill,
 * the query budget, restarts). The worker itself and the routes: search-worker-2293 / search-web-2293.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseQuery, snippetOf, SearchStore, SHORT_SCAN_ROWS, QUERY_MAX_TERMS, type SearchDoc } from "../src/search/search-store.js";
import { chatDoc, taskDoc, xmsgDoc, xmsgFromOutbox, xmsgShown } from "../src/search/search-docs.js";
import { xmsgVisibility } from "../src/cross-instance-notice.js";
import { BATCH_MAX, BATCH_MS, BACKFILL_CHUNK, PENDING_MAX, QUERY_BUDGET_MS, QUEUE_MAX, SearchIndex } from "../src/search/search-index.js";
import type { WebChatMessage } from "../src/web-chat-history.js";

const dirs: string[] = [];
const stores: SearchStore[] = [];
afterEach(() => { stores.splice(0).forEach(s => s.close()); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); vi.useRealTimers(); });
function store(): SearchStore {
  const dir = mkdtempSync(join(tmpdir(), "search-2293-")); dirs.push(dir);
  const s = new SearchStore(join(dir, "search.db")); stores.push(s); return s;
}
const T0 = Date.UTC(2026, 9, 1);
let n = 0;
function doc(over: Partial<SearchDoc> & { text: string }): SearchDoc {
  n++;
  return { key: `chat:dev:b-${n}`, source: "chat", instance: "dev", sender: "han", role: "user", ts: T0 + n * 1000, ref: { boot: "b", id: n }, ...over };
}
const keys = (r: { hits: Array<{ key: string }> }) => r.hits.map(h => h.key);

describe("parseQuery / snippetOf", () => {
  it("splits on whitespace, lowercases, dedups, at most QUERY_MAX_TERMS; 3+ chars go to FTS, shorter ones are scanned", () => {
    expect(parseQuery("  NGINX  改 nginx 部署到 ab ")).toEqual({ long: ["nginx", "部署到"], short: ["改", "ab"] });
    expect(parseQuery("a b c d e f g h i j").short).toHaveLength(QUERY_MAX_TERMS);
    expect(parseQuery("   ")).toEqual({ long: [], short: [] });
  });
  it("a window around the first hit, marked, with … where it was cut", () => {
    const text = "x".repeat(100) + " the nginx config " + "y".repeat(300);
    const s = snippetOf(text, ["nginx"]);
    expect(s.snippet.startsWith("…") && s.snippet.endsWith("…")).toBe(true);
    const [a, b] = s.marks[0]!;
    expect(s.snippet.slice(a, b)).toBe("nginx");
    expect(snippetOf("short NGINX text", ["nginx"])).toEqual({ snippet: "short NGINX text", marks: [[6, 11]] });
  });
});

describe("SearchStore", () => {
  it("finds a word anywhere (trigram), CJK included, newest first; 1–2 character terms and mixed queries too", () => {
    const s = store();
    s.add([doc({ text: "請幫我改 nginx 的設定" }), doc({ text: "部署到 staging 的服務壞了" }), doc({ text: "unrelated" }), doc({ text: "NGINX staging restart" })]);
    expect(keys(s.search({ q: "nginx" }))).toEqual([`chat:dev:b-${n}`, `chat:dev:b-${n - 3}`]);
    expect(keys(s.search({ q: "服務" }))).toEqual([`chat:dev:b-${n - 2}`]);
    expect(keys(s.search({ q: "改" }))).toEqual([`chat:dev:b-${n - 3}`]);
    expect(keys(s.search({ q: "nginx staging" }))).toEqual([`chat:dev:b-${n}`]);
    expect(keys(s.search({ q: "nginx 改" }))).toEqual([`chat:dev:b-${n - 3}`]);
    expect(s.search({ q: "nope-nothing" }).hits).toEqual([]);
  });
  it("quotes and FTS syntax in a query are words, never operators", () => {
    const s = store();
    s.add([doc({ text: 'he said "hello" OR NOT' }), doc({ text: "nothing" })]);
    expect(keys(s.search({ q: '"hello" OR' }))).toEqual([`chat:dev:b-${n - 1}`]);
    expect(() => s.search({ q: 'NEAR( "unbalanced * ^ -' })).not.toThrow();
  });
  it("masks secrets before they are stored: the token is not found and its snippet shows [REDACTED]", () => {
    const s = store();
    s.add([doc({ text: `deploy with ghp_${"a".repeat(36)} now` })]);
    expect(s.search({ q: "ghp_aaaa" }).hits).toEqual([]);
    expect(s.search({ q: "deploy" }).hits[0]!.snippet).toBe("deploy with [REDACTED] now");
  });
  it("short terms alone scan only the newest SHORT_SCAN_ROWS matching rows, and say so (limited)", () => {
    const s = store();
    s.add(Array.from({ length: SHORT_SCAN_ROWS + 5 }, (_, i) => doc({ text: i === 0 ? "the oldest 改" : "row" })));
    const r = s.search({ q: "改" });
    expect([r.hits.length, r.limited]).toEqual([0, true]);
    const few = store(); few.add([doc({ text: "改" })]);
    expect(few.search({ q: "改" }).limited).toBe(false);
  });
  it("filters: instance (or a message's peer), source, since/until, mine, limit", () => {
    const s = store();
    s.add([
      doc({ text: "nginx a", instance: "a", mine: "discord:1" }),
      doc({ key: "xmsg:m1:b", source: "xmsg", instance: "lead", peer: "b", text: "nginx to b", role: "task", ref: {} }),
      doc({ key: "task:t1", source: "task", instance: "c", text: "nginx task", role: "open", ref: {} }),
    ]);
    expect(keys(s.search({ q: "nginx", instances: ["b"] }))).toEqual(["xmsg:m1:b"]);
    expect(keys(s.search({ q: "nginx", instances: ["a", "c"] })).sort()).toEqual([`chat:dev:b-${n - 2}`, "task:t1"].sort());
    expect(keys(s.search({ q: "nginx", sources: ["task"] }))).toEqual(["task:t1"]);
    expect(keys(s.search({ q: "nginx", since: T0 + (n - 1) * 1000 }))).toEqual(["task:t1", "xmsg:m1:b"]);
    expect(keys(s.search({ q: "nginx", until: T0 + (n - 1) * 1000 }))).toEqual([`chat:dev:b-${n - 2}`]);
    expect(keys(s.search({ q: "nginx", mine: ["discord:1"] }))).toEqual([`chat:dev:b-${n - 2}`]);
    expect(s.search({ q: "nginx", limit: 1 }).hits).toHaveLength(1);
  });
  it("hidden: no cross-instance message to or from a hidden name; xmsgAmong: only between those (an empty list: none)", () => {
    const s = store();
    s.add([
      doc({ key: "xmsg:1:b", source: "xmsg", instance: "a", peer: "b", text: "nginx ab", ref: {} }),
      doc({ key: "xmsg:2:a", source: "xmsg", instance: "h", peer: "a", text: "nginx ha", ref: {} }),
      doc({ key: "chat:h:b-1", instance: "h", text: "nginx in h's own chat" }),
    ]);
    expect(keys(s.search({ q: "nginx", hidden: ["h"] })).sort()).toEqual(["chat:h:b-1", "xmsg:1:b"]);
    expect(keys(s.search({ q: "nginx", xmsgAmong: ["a", "b"] })).sort()).toEqual(["chat:h:b-1", "xmsg:1:b"]);
    expect(keys(s.search({ q: "nginx", xmsgAmong: ["a"] }))).toEqual(["chat:h:b-1"]);
    expect(keys(s.search({ q: "nginx", xmsgAmong: [] }))).toEqual(["chat:h:b-1"]);
  });
  it("a key is written once: a task's update replaces its doc", () => {
    const s = store();
    s.add([doc({ key: "task:t", source: "task", text: "old title", ref: {} })]);
    s.add([doc({ key: "task:t", source: "task", text: "new title", ref: {} })]);
    expect([s.count(), keys(s.search({ q: "old" })), keys(s.search({ q: "new title" }))]).toEqual([1, [], ["task:t"]]);
  });
  it("prune: older than the cutoff, then the oldest beyond the cap, in chunks that say whether more are left", () => {
    const s = store();
    s.add(Array.from({ length: 10 }, (_, i) => doc({ text: `row ${i}`, ts: T0 + i })));
    expect(s.prune(T0 + 3, 100, 2)).toEqual({ removed: 2, more: true });
    while (s.prune(T0 + 3, 100, 2).more) { /* drain */ }
    expect(s.count()).toBe(7);
    expect(s.prune(0, 5, 100)).toEqual({ removed: 2, more: false });
    expect(keys(s.search({ q: "row" })).length).toBe(5);
    expect(s.search({ q: "row 3" }).hits).toEqual([]);
  });
  it("removeInstance takes its chat only: messages and tasks it had a side in stay", () => {
    const s = store();
    s.add([doc({ instance: "x", text: "nginx chat" }), doc({ key: "xmsg:1:y", source: "xmsg", instance: "x", peer: "y", text: "nginx msg", ref: {} }),
      doc({ key: "task:1", source: "task", instance: "x", text: "nginx task", ref: {} })]);
    expect(s.removeInstance("x")).toBe(1);
    expect(keys(s.search({ q: "nginx" })).sort()).toEqual(["task:1", "xmsg:1:y"]);
  });
  it("context: the doc with its chat neighbours of the same instance, in order", () => {
    const s = store();
    const rows = [doc({ text: "one" }), doc({ text: "two" }), doc({ instance: "other", text: "elsewhere" }), doc({ text: "three" })];
    s.add(rows);
    const c = s.context(rows[1]!.key)!;
    expect([c.before.map(d => d.text), c.doc.text, c.after.map(d => d.text)]).toEqual([["one"], "two", ["three"]]);
    expect(s.context("missing")).toBeNull();
  });
  it("built() only after markBuilt; invalid docs are skipped, never thrown", () => {
    const s = store();
    expect(s.built()).toBe(false);
    s.markBuilt(Date.now());
    expect(s.built()).toBe(true);
    expect(s.add([{ key: "", source: "chat", instance: "a", sender: "x", ts: 1, ref: {}, text: "x" }, { key: "k", source: "nope" as never, instance: "a", sender: "x", ts: 1, ref: {}, text: "x" }])).toBe(0);
  });
});

describe("what each source indexes", () => {
  const msg = (over: Partial<WebChatMessage>): WebChatMessage => ({ instance: "dev", boot: "b1", id: 7, role: "user", sender: "han", text: "hello", ts: "2026-10-01T00:00:00.000Z", ...over } as WebChatMessage);
  it("chat: a person's or agent's message (a click's label, its files' names); never a status line or an effect offer", () => {
    expect(chatDoc(msg({ from: "discord:1" }))).toEqual({ key: "chat:dev:b1-7", source: "chat", instance: "dev", sender: "han", role: "user", mine: "discord:1", ts: Date.parse("2026-10-01T00:00:00.000Z"), ref: { boot: "b1", id: 7 }, text: "hello" });
    expect(chatDoc(msg({ role: "status" }))).toBeNull();
    expect(chatDoc(msg({ effectTrial: { offer: "x" } as never }))).toBeNull();
    expect(chatDoc(msg({ text: "the line the agent got", click: { label: "Approve" } as never }))!.text).toBe("Approve");
    expect(chatDoc(msg({ text: "see", attachments: [{ id: "1", kind: "document", name: "nginx.conf", size: 1, mime: "text/plain" }] }))!.text).toBe("see\nnginx.conf");
    expect(chatDoc(msg({ text: "  " }))).toBeNull();
  });
  it("chat: 'mine' is the account; a web message with none is the operator's; an agent's is nobody's", () => {
    expect(chatDoc(msg({ messageId: "web-1" }))!.mine).toBe("web:operator");
    expect(chatDoc(msg({}))!.mine).toBeUndefined();
    expect(chatDoc(msg({ role: "agent", from: "discord:1" }))!.mine).toBeUndefined();
  });
  it("xmsg: the content and summary, sender → target — and from the outbox, the same doc; never forwards, paths or a branch", () => {
    const payload = { content: "fix nginx", meta: { from_instance: "lead", message_id: "xmsg-1", request_kind: "task", task_summary: "nginx", correlation_id: "cid-1", forwards: "SECRETFWD", working_directory: "/secret/dir", branch: "secret-branch", ts: "2026-10-01T00:00:00.000Z" } };
    const fromOutbox = xmsgDoc(xmsgFromOutbox("dev", "2026-10-02T00:00:00.000Z", JSON.stringify(payload), "fleet_inbound")!)!;
    expect(fromOutbox).toEqual({ key: "xmsg:xmsg-1:dev", source: "xmsg", instance: "lead", peer: "dev", sender: "lead", role: "task", ts: Date.parse("2026-10-01T00:00:00.000Z"),
      ref: { messageId: "xmsg-1", kind: "task", correlationId: "cid-1" }, text: "nginx\nfix nginx" });
    expect(JSON.stringify(fromOutbox)).not.toMatch(/SECRETFWD|secret\/dir|secret-branch/);
    // A person's message or a fleet notice in the outbox (no from_instance) is not a cross-instance message.
    expect(xmsgFromOutbox("dev", "x", JSON.stringify({ content: "hi", meta: { message_id: "m" } }))).toBeNull();
    expect(xmsgFromOutbox("dev", "x", "{not json")).toBeNull();
    // A broadcast without a request kind is "broadcast", live and from the outbox alike.
    expect(xmsgFromOutbox("dev", "x", JSON.stringify({ content: "all", meta: { from_instance: "a", message_id: "bcast-1" } }), "broadcast")!.kind).toBe("broadcast");
  });
  it("task: title, description, result; its status, assignee (else creator); one doc per task", () => {
    const d = taskDoc({ id: "t1", title: "Upgrade nginx", description: "on staging", result: null, status: "claimed", assignee: "dev", created_by: "lead", updated_at: "2026-10-01T00:00:00.000Z" })!;
    expect(d).toMatchObject({ key: "task:t1", source: "task", instance: "dev", sender: "lead", role: "claimed", text: "Upgrade nginx\non staging", ref: { taskId: "t1" } });
    expect(taskDoc({ id: "t2", title: "x", status: "open", created_by: "lead" })!.instance).toBe("lead");
  });
  it("visibility: per instance, or every name but those set to show theirs when the fleet's default is hidden", () => {
    const fleet = { defaults: {}, instances: { a: {}, h: { cross_instance_visibility: "hidden" } } } as never;
    expect(xmsgVisibility(fleet)).toEqual({ hidden: ["h"] });
    const byDefault = { defaults: { cross_instance_visibility: "hidden" }, instances: { a: { cross_instance_visibility: "full" }, b: {} } } as never;
    expect(xmsgVisibility(byDefault)).toEqual({ among: ["a"] });
    const x = { source: "xmsg", instance: "a", peer: "ext-session" };
    expect([xmsgShown(x, { hidden: ["h"] }), xmsgShown(x, { among: ["a"] }), xmsgShown({ ...x, source: "chat" }, { among: [] })]).toEqual([true, false, true]);
  });
});

/** A worker that records what it is sent; the test answers. */
class FakeWorker extends EventEmitter {
  sent: any[] = [];
  terminated = false;
  postMessage(m: unknown) { this.sent.push(m); }
  terminate() { this.terminated = true; return Promise.resolve(0); }
  unref() { return this; }
  reply(op: string, value: unknown, ok = true) {
    const m = [...this.sent].reverse().find(x => x.op === op && x.id !== undefined);
    this.emit("message", { op: "reply", id: m.id, ok, value });
  }
  ops() { return this.sent.map(m => m.op); }
}
function lane(chatDocs: () => Iterable<SearchDoc> = () => []) {
  const workers: FakeWorker[] = [];
  const logs: string[] = [];
  const index = new SearchIndex({ path: "/x/search.db", retentionDays: 90, outboxPath: "/x/o.db", schedulerPath: "/x/s.db", chatDocs,
    factory: () => { const w = new FakeWorker(); workers.push(w); return w; }, log: (l, m) => logs.push(`${l}:${m}`), now: () => T0 + 100 * 86400_000 });
  return { index, workers, logs, w: () => workers[workers.length - 1]! };
}
const tick = () => new Promise<void>(r => setImmediate(r));

describe("SearchIndex (the fleet's lane)", () => {
  it("a built index: ready, writes batched every BATCH_MS or at BATCH_MAX", async () => {
    vi.useFakeTimers();
    const { index, w } = lane();
    index.start();
    w().emit("message", { op: "ready", built: true });
    expect(index.status()).toBe("ready");
    index.record(doc({ text: "one" })); index.record(null);
    expect(w().ops().filter(o => o === "add")).toEqual([]);
    vi.advanceTimersByTime(BATCH_MS);
    expect(w().sent.filter(m => m.op === "add").map(m => m.docs.length)).toEqual([1]);
    for (let i = 0; i < BATCH_MAX; i++) index.record(doc({ text: "x" }));
    expect(w().sent.filter(m => m.op === "add").map(m => m.docs.length)).toEqual([1, BATCH_MAX]);
  });
  it("while starting, records wait (at most QUEUE_MAX, the oldest go) and are sent once it is ready", () => {
    const { index, w } = lane();
    index.start();
    for (let i = 0; i < QUEUE_MAX + 3; i++) index.record(doc({ text: `q${i}` }));
    expect(w().ops()).toEqual([]);
    w().emit("message", { op: "ready", built: true });
    const added = w().sent.filter(m => m.op === "add").flatMap(m => m.docs);
    expect([added.length, added[0].text]).toEqual([QUEUE_MAX, "q3"]);
  });
  it("a new index is backfilled: chat docs in chunks (inside retention), then the worker's SQLite read, then built", async () => {
    const chats = Array.from({ length: BACKFILL_CHUNK + 1 }, () => doc({ text: "c", ts: T0 + 99 * 86400_000 }));
    chats.push(doc({ text: "too old", ts: T0 }));
    const { index, w, logs } = lane(() => chats);
    index.start();
    w().emit("message", { op: "ready", built: false });
    expect(index.status()).toBe("building");
    await tick(); await tick();
    const adds = w().sent.filter(m => m.op === "add").map(m => m.docs.length);
    expect(adds).toEqual([BACKFILL_CHUNK, 1]);
    const bf = w().sent.find(m => m.op === "backfill");
    expect(bf).toMatchObject({ outboxPath: "/x/o.db", schedulerPath: "/x/s.db", cutoff: T0 + 10 * 86400_000 });
    // Answers while it builds, and says so.
    const q = index.query({ q: "c" });
    w().reply("query", { hits: [], limited: false });
    expect(await q).toEqual({ ok: true, value: { hits: [], limited: false }, building: true });
    w().emit("message", { op: "reply", id: bf.id, ok: true, value: { xmsg: 2, tasks: 1 } });
    await tick();
    expect(w().ops()).toContain("markBuilt");
    expect(index.status()).toBe("ready");
    expect(logs.some(l => /index built \(201 chat, 2 cross-instance, 1 task docs/.test(l))).toBe(true);
    expect(w().ops()).toContain("prune");
  });
  it("a query past QUERY_BUDGET_MS: timeout; more than PENDING_MAX at once: busy; no worker: unavailable", async () => {
    vi.useFakeTimers();
    const { index, w } = lane();
    expect(await index.query({ q: "x" })).toEqual({ ok: false, reason: "unavailable" });
    index.start(); w().emit("message", { op: "ready", built: true });
    const slow = index.query({ q: "x" });
    vi.advanceTimersByTime(QUERY_BUDGET_MS);
    expect(await slow).toEqual({ ok: false, reason: "timeout" });
    const many = Array.from({ length: PENDING_MAX }, () => index.query({ q: "x" }));
    expect(await index.query({ q: "x" })).toEqual({ ok: false, reason: "busy" });
    vi.advanceTimersByTime(QUERY_BUDGET_MS); await Promise.all(many);
  });
  it("a worker that exits is started again after a backoff that doubles; pending queries end unavailable", async () => {
    vi.useFakeTimers();
    const { index, workers, w } = lane();
    index.start(); w().emit("message", { op: "ready", built: true });
    const q = index.query({ q: "x" });
    w().emit("exit", 1);
    expect(await q).toEqual({ ok: false, reason: "unavailable" });
    expect(index.status()).toBe("starting");
    vi.advanceTimersByTime(999); expect(workers).toHaveLength(1);
    vi.advanceTimersByTime(1); expect(workers).toHaveLength(2);
    w().emit("exit", 1);
    vi.advanceTimersByTime(1999); expect(workers).toHaveLength(2);
    vi.advanceTimersByTime(1); expect(workers).toHaveLength(3);
    // The old worker's late messages change nothing.
    workers[0]!.emit("message", { op: "ready", built: true });
    expect(index.status()).toBe("starting");
  });
  it("a file it cannot open at all (not corrupt): unavailable for good — no restart loop", () => {
    vi.useFakeTimers();
    const { index, workers, w, logs } = lane();
    index.start();
    w().emit("message", { op: "failed", reason: "SQLITE_CANTOPEN" });
    w().emit("exit", 0);
    vi.advanceTimersByTime(120_000);
    expect([index.status(), workers.length, logs.some(l => l.includes("SQLITE_CANTOPEN"))]).toEqual(["unavailable", 1, true]);
  });
  it("removeInstance drops its queued chat (not its messages) and tells the worker; close flushes then closes", () => {
    const { index, w } = lane();
    index.start();
    index.record(doc({ instance: "gone", text: "a" }));
    index.record(doc({ key: "xmsg:1:z", source: "xmsg", instance: "gone", peer: "z", text: "b" }));
    index.removeInstance("gone");
    w().emit("message", { op: "ready", built: true });
    expect(w().sent.filter(m => m.op === "add").flatMap(m => m.docs.map((d: SearchDoc) => d.key))).toEqual(["xmsg:1:z"]);
    expect(w().sent.find(m => m.op === "removeInstance")).toEqual({ op: "removeInstance", instance: "gone" });
    index.record(doc({ text: "last" }));
    index.close();
    expect(w().ops().slice(-2)).toEqual(["add", "close"]);
    expect(index.status()).toBe("unavailable");
  });
});
