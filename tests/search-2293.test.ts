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
import { maskSecrets } from "../src/log-steps.js";
import { xmsgVisibility } from "../src/cross-instance-notice.js";
import { BATCH_MAX, BATCH_MS, BACKFILL_CHUNK, PENDING_MAX, QUERY_BUDGET_MS, QUEUE_MAX, STALL_MS, SearchIndex } from "../src/search/search-index.js";
import { WebChatHistory } from "../src/web-chat-history.js";
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
  ack(batch: number) { this.emit("message", { op: "added", batch }); }
}
function lane(chatDocs: () => Iterable<SearchDoc> = () => [], retentionDays = 90) {
  const workers: FakeWorker[] = [];
  const logs: string[] = [];
  const index = new SearchIndex({ path: "/x/search.db", retentionDays, outboxPath: "/x/o.db", schedulerPath: "/x/s.db", chatDocs,
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
  it("while starting, records wait (at most QUEUE_MAX, the oldest go) and are sent once it is ready, BATCH_MAX a batch", () => {
    vi.useFakeTimers();
    const { index, w } = lane();
    index.start();
    for (let i = 0; i < QUEUE_MAX + 3; i++) index.record(doc({ text: `q${i}` }));
    expect(w().ops()).toEqual([]);
    w().emit("message", { op: "ready", built: true });
    vi.advanceTimersByTime(100);
    const adds = w().sent.filter(m => m.op === "add");
    const added = adds.flatMap(m => m.docs);
    expect([added.length, added[0].text, Math.max(...adds.map(m => m.docs.length))]).toEqual([QUEUE_MAX, "q3", BATCH_MAX]);
  });
  it("uncommitted docs are bounded: while QUEUE_MAX wait for their commit, new ones wait in the capped queue", () => {
    vi.useFakeTimers();
    const { index, w } = lane();
    index.start(); w().emit("message", { op: "ready", built: true });
    for (let i = 0; i < QUEUE_MAX + BATCH_MAX; i++) index.record(doc({ text: "x" }));
    vi.advanceTimersByTime(10_000);
    const posted = () => w().sent.filter(m => m.op === "add").reduce((n, m) => n + m.docs.length, 0);
    expect(posted()).toBe(QUEUE_MAX);
    w().ack(w().sent.find(m => m.op === "add").batch);
    vi.advanceTimersByTime(BATCH_MS);
    expect(posted()).toBe(QUEUE_MAX + BATCH_MAX);
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
  it("retentionDays 0: old chat is backfilled and prune/backfill cutoff is 0 (no age prune)", async () => {
    const chats = [doc({ text: "too old", ts: T0 }), doc({ text: "kept", ts: T0 + 99 * 86400_000 })];
    const { index, w } = lane(() => chats, 0);
    index.start();
    w().emit("message", { op: "ready", built: false });
    await tick(); await tick();
    const added = w().sent.filter(m => m.op === "add").flatMap(m => m.docs.map((d: SearchDoc) => d.text));
    expect(added).toEqual(["too old", "kept"]);
    const bf = w().sent.find(m => m.op === "backfill");
    expect(bf.cutoff).toBe(0);
    w().emit("message", { op: "reply", id: bf.id, ok: true, value: { xmsg: 0, tasks: 0 } });
    await tick();
    expect(w().sent.find(m => m.op === "prune").cutoff).toBe(0);
  });
  it("a query past QUERY_BUDGET_MS: answered timeout, but it holds its place until the worker is done with it", async () => {
    vi.useFakeTimers();
    const { index, w } = lane();
    expect(await index.query({ q: "x" })).toEqual({ ok: false, reason: "unavailable" });
    index.start(); w().emit("message", { op: "ready", built: true });
    const held = Array.from({ length: PENDING_MAX }, () => index.query({ q: "x" }));
    vi.advanceTimersByTime(QUERY_BUDGET_MS);
    expect(await Promise.all(held)).toEqual(Array(PENDING_MAX).fill({ ok: false, reason: "timeout" }));
    // Timed out, still in the worker: no new query goes to it.
    expect(await index.query({ q: "x" })).toEqual({ ok: false, reason: "busy" });
    expect(w().sent.filter(m => m.op === "query")).toHaveLength(PENDING_MAX);
    // The worker finishes one (late — its caller was answered): one place frees.
    const first = w().sent.find(m => m.op === "query");
    w().emit("message", { op: "reply", id: first.id, ok: true, value: { hits: [], limited: false } });
    const next = index.query({ q: "y" });
    expect(w().sent.filter(m => m.op === "query")).toHaveLength(PENDING_MAX + 1);
    w().reply("query", { hits: [], limited: false });
    expect(await next).toEqual({ ok: true, value: { hits: [], limited: false }, building: false });
  });
  it("a query still held STALL_MS after it was asked: the worker is retired and started again; its holds end", async () => {
    vi.useFakeTimers();
    const { index, workers, w, logs } = lane();
    index.start(); w().emit("message", { op: "ready", built: true });
    void index.query({ q: "x" });
    vi.advanceTimersByTime(STALL_MS - 1);
    expect(workers[0]!.terminated).toBe(false);
    vi.advanceTimersByTime(1);
    expect([workers[0]!.terminated, logs.some(l => l.includes("held the index worker too long"))]).toEqual([true, true]);
    workers[0]!.emit("exit", 1);
    vi.advanceTimersByTime(1000);
    expect(workers).toHaveLength(2);
    w().emit("message", { op: "ready", built: true });
    expect(index.status()).toBe("ready");
    // The old hold is gone: a full set of new queries goes to the new worker.
    for (let i = 0; i < PENDING_MAX; i++) void index.query({ q: "x" });
    expect(w().sent.filter(m => m.op === "query")).toHaveLength(PENDING_MAX);
  });
  it("a query answered in time: no stall, no retire", async () => {
    vi.useFakeTimers();
    const { index, workers, w } = lane();
    index.start(); w().emit("message", { op: "ready", built: true });
    const q = index.query({ q: "x" });
    w().reply("query", { hits: [], limited: false });
    await q;
    vi.advanceTimersByTime(STALL_MS * 2);
    expect(workers[0]!.terminated).toBe(false);
  });
  it("a batch the worker had not committed when it went is sent again to the next one; a committed one is not", () => {
    vi.useFakeTimers();
    const { index, workers, w } = lane();
    index.start(); w().emit("message", { op: "ready", built: true });
    index.record(doc({ key: "chat:dev:b-c", text: "committed" }));
    vi.advanceTimersByTime(BATCH_MS);
    w().ack(w().sent.find(m => m.op === "add").batch);
    index.record(doc({ key: "chat:dev:b-u", text: "uncommitted" }));
    vi.advanceTimersByTime(BATCH_MS);
    const lost = w().sent.filter(m => m.op === "add")[1];
    workers[0]!.emit("exit", 1);
    // The old worker's late ack changes nothing: the new worker gets the batch anyway.
    workers[0]!.emit("message", { op: "added", batch: lost.batch });
    vi.advanceTimersByTime(1000);
    w().emit("message", { op: "ready", built: true });
    const replayed = w().sent.filter(m => m.op === "add").flatMap(m => m.docs.map((d: SearchDoc) => d.key));
    expect(replayed).toEqual(["chat:dev:b-u"]);
    // Committed by the new worker: not sent a third time.
    w().ack(lost.batch);
    workers[1]!.emit("exit", 1);
    vi.advanceTimersByTime(2000);
    w().emit("message", { op: "ready", built: true });
    expect(w().sent.filter(m => m.op === "add")).toEqual([]);
  });
  it("a removed instance's chat in an uncommitted batch is not sent again after the removal (a replay would restore it)", () => {
    vi.useFakeTimers();
    const { index, workers, w } = lane();
    index.start(); w().emit("message", { op: "ready", built: true });
    index.record(doc({ key: "chat:gone:b-1", instance: "gone", text: "old" }));
    index.record(doc({ key: "chat:dev:b-2", instance: "dev", text: "kept" }));
    vi.advanceTimersByTime(BATCH_MS);
    index.removeInstance("gone");
    workers[0]!.emit("exit", 1);
    vi.advanceTimersByTime(1000);
    w().emit("message", { op: "ready", built: true });
    expect(w().sent.filter(m => m.op !== "prune").map(m => m.op === "add" ? m.docs.map((d: SearchDoc) => d.key) : m.op)).toEqual(["removeInstance", ["chat:dev:b-2"]]);
  });
  it("a removal the worker did not confirm is sent first to the next worker; confirmed (or a later batch committed): not", () => {
    vi.useFakeTimers();
    const { index, workers, w } = lane();
    index.start(); w().emit("message", { op: "ready", built: true });
    index.removeInstance("gone");
    workers[0]!.emit("exit", 1);
    vi.advanceTimersByTime(1000);
    index.record(doc({ instance: "gone", text: "a new instance of the same name" }));
    w().emit("message", { op: "ready", built: true });
    expect(w().ops().slice(0, 2)).toEqual(["removeInstance", "add"]);
    w().emit("message", { op: "removed", instance: "gone" });
    index.removeInstance("other");
    index.record(doc({ text: "later" }));
    vi.advanceTimersByTime(BATCH_MS);
    const later = w().sent.filter(m => m.op === "add").pop();
    w().ack(later.batch);                                  // in order: "other" was removed before it
    w().ack(w().sent.find(m => m.op === "add").batch);
    workers[1]!.emit("exit", 1);
    vi.advanceTimersByTime(2000);
    w().emit("message", { op: "ready", built: true });
    expect(w().ops().filter(o => o !== "prune")).toEqual([]);
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
    expect(w().sent.find(m => m.op === "removeInstance")).toEqual({ op: "removeInstance", instance: "gone", gen: 1 });
    index.record(doc({ text: "last" }));
    index.close();
    expect(w().ops().slice(-2)).toEqual(["add", "close"]);
    expect(index.status()).toBe("unavailable");
  });
  it("an instance removed while the backfill runs: none of its old chat stays; a new instance of the name shows only its own", async () => {
    const s = store();
    const history = new WebChatHistory({ boot: "b1" });
    const ts = new Date(T0 + 99 * 86400_000).toISOString();
    for (let i = 0; i < 500; i++) history.record({ instance: "gone", sender: "x", text: `old chat ${i}`, ts, role: "user" });
    history.record({ instance: "kept", sender: "x", text: "kept chat", ts, role: "user" });
    let index!: SearchIndex;
    const worker = new StoreWorker(s, (adds) => { if (adds === 1) { history.forget("gone"); index.removeInstance("gone"); } });
    index = new SearchIndex({ path: "/x", retentionDays: 90, chatDocs: function* () { for (const n of history.instances()) for (const m of history.list(n)) { const d = chatDoc(m); if (d) yield d; } },
      factory: () => worker as never, now: () => T0 + 100 * 86400_000 });
    index.start(); worker.ready(false);
    for (let i = 0; i < 100 && index.status() !== "ready"; i++) await tick();
    expect(index.status()).toBe("ready");
    expect(worker.adds).toBeGreaterThan(1);                       // removed between the backfill's chunks
    expect([history.list("gone").length, s.search({ q: "chat", instances: ["gone"] }).hits.length, s.search({ q: "kept chat" }).hits.length]).toEqual([0, 0, 1]);
    const fresh = history.record({ instance: "gone", sender: "y", text: "new chat", ts, role: "user" });
    index.record(chatDoc(fresh));
    await new Promise(r => setTimeout(r, BATCH_MS + 50));
    expect(s.search({ q: "chat", instances: ["gone"] }).hits.map(h => h.snippet)).toEqual(["new chat"]);
    // A removal with no backfill running: the same.
    index.removeInstance("kept");
    await tick();
    expect(s.search({ q: "kept chat" }).hits).toEqual([]);
    index.close();
  });
});

describe("#2295 review r2: boundaries", () => {
  it("a secret cut open by the chat history's 16000 characters: history → chatDoc → store masks it; controls kept", () => {
    const s = store();
    const history = new WebChatHistory({ boot: "b1" });
    const ts = new Date(T0).toISOString();
    const cut = history.record({ instance: "dev", sender: "han", text: `${"x".repeat(15976)} password="horse battery staple"`, ts, role: "user" });
    const json = history.record({ instance: "dev", sender: "han", text: `${"x".repeat(15980)} {"api_key": "correct horse stapler"}`, ts, role: "user" });
    expect([cut.text.length, cut.text.endsWith('password="horse battery')]).toEqual([16000, true]);   // the precondition
    const prose = history.record({ instance: "dev", sender: "han", text: 'deploy nginx, he said "hello', ts, role: "user" });
    const closed = history.record({ instance: "dev", sender: "han", text: 'rotate token: "abc def" today', ts, role: "user" });
    s.add([chatDoc(cut)!, chatDoc(json)!, chatDoc(prose)!, chatDoc(closed)!]);
    for (const q of ["horse battery", "horse", "correct horse", "abc def"]) expect(s.search({ q }).hits, q).toEqual([]);
    for (const m of [cut, json]) expect(s.context(`chat:dev:b1-${m.id}`)!.doc.text).toMatch(/\[REDACTED\]$/);
    expect(s.search({ q: "hello" }).hits.map(h => h.key)).toEqual([`chat:dev:b1-${prose.id}`]);
    expect(s.search({ q: "rotate" }).hits[0]!.snippet).toMatch(/^rotate token: "?\[REDACTED\]"? today$/);
  });
  it("every cut point inside a quoted secret, for each syntax, through the history: nothing of the value is kept (r4)", () => {
    const syntaxes = [["double", '"', '"', "horse's battery staple"], ["single", "'", "'", 'horse "battery" staple'], ["escaped", '\\"', '\\"', "horse's battery staple"]] as const;
    let cases = 0;
    for (const [name, open, close, value] of syntaxes) {
      const head = `password=${open}`, segment = `${head}${value}${close} end`;
      expect(maskSecrets(`run ${segment}`), name).not.toMatch(/horse|battery|staple/);   // the whole text: masked (precondition)
      for (let cut = head.length; cut < head.length + value.length + close.length; cut++) {
        const s = store();
        const history = new WebChatHistory({ boot: "c" });
        const m = history.record({ instance: "dev", sender: "han", text: `${"x".repeat(16000 - 1 - cut)} ${segment}`, ts: new Date(T0).toISOString(), role: "user" });
        expect(m.text.length).toBe(16000);
        expect(m.text.endsWith(segment.slice(0, cut)), `${name} @${cut}`).toBe(true);
        s.add([chatDoc(m)!]);
        const kept = s.context(`chat:dev:c-${m.id}`)!.doc.text.slice(15900);
        expect(kept, `${name} @${cut}: ${JSON.stringify(segment.slice(0, cut))}`).not.toMatch(/hor|ors|bat|att|tte|ter|sta|tap|apl|ple/);
        for (const q of ["horse", "batt", "stap"]) expect(s.search({ q }).hits, `${name} @${cut} ${q}`).toEqual([]);
        s.close(); stores.splice(stores.indexOf(s), 1);
        cases++;
      }
    }
    expect(cases).toBe(23 + 23 + 24);
  });
  it("the open tail ends only at its own delimiter: the other quote inside the value is the value's (r3)", () => {
    const s = store();
    const history = new WebChatHistory({ boot: "b2" });
    const ts = new Date(T0).toISOString();
    const pad = "x".repeat(15974) + " ";
    const rows = [`password="horse's battery staple"`, `password='horse "battery" staple'`, `PASSWORD=\\"horse's "battery" staple\\"`]
      .map(v => history.record({ instance: "dev", sender: "han", text: pad + v, ts, role: "user" }));
    for (const m of rows) expect(m.text.length).toBe(16000);               // cut inside the value: the precondition
    const prose = history.record({ instance: "dev", sender: "han", text: `deploy nginx, he said "it's fine`, ts, role: "user" });
    s.add([...rows, prose].map(m => chatDoc(m)!));
    for (const q of ["horse", "battery"]) expect(s.search({ q }).hits, q).toEqual([]);
    for (const m of rows) expect(s.context(`chat:dev:b2-${m.id}`)!.doc.text, m.text.slice(15975)).not.toMatch(/horse|battery/);
    expect(s.search({ q: "it's fine" }).hits.map(h => h.key)).toEqual([`chat:dev:b2-${prose.id}`]);
  });
  it("a removal's ack confirms only its own: removed, re-created, removed again — the old ack leaves the new removal pending", () => {
    vi.useFakeTimers();
    const { index, workers, w } = lane();
    index.start(); w().emit("message", { op: "ready", built: true });
    index.removeInstance("A");                                     // #1
    index.record(doc({ key: "chat:A:b-new", instance: "A", text: "the new A's chat" }));
    vi.advanceTimersByTime(BATCH_MS);
    const batch = w().sent.filter(m => m.op === "add").pop();
    index.removeInstance("A");                                     // #2, after the new chat
    const [first, second] = w().sent.filter(m => m.op === "removeInstance");
    expect([first.gen, second.gen]).toEqual([1, 2]);
    w().emit("message", { op: "removed", instance: "A", gen: first.gen });   // #1 done
    w().ack(batch.batch);                                          // the new chat written — #2 was posted after it
    workers[0]!.emit("exit", 1);
    vi.advanceTimersByTime(1000);
    w().emit("message", { op: "ready", built: true });
    expect(w().sent.filter(m => m.op === "removeInstance")).toEqual([{ op: "removeInstance", instance: "A", gen: 2 }]);
    // Its own ack: done, not sent again.
    w().emit("message", { op: "removed", instance: "A", gen: 2 });
    workers[1]!.emit("exit", 1);
    vi.advanceTimersByTime(2000);
    w().emit("message", { op: "ready", built: true });
    expect(w().ops().filter(o => o !== "prune")).toEqual([]);
  });
  it("the backfill stays under QUEUE_MAX uncommitted docs, waits for commits, then finishes; a worker that goes ends the wait", async () => {
    const chats = Array.from({ length: 10_000 }, (_, i) => doc({ key: `chat:i${i % 20}:b-${i}`, instance: `i${i % 20}`, text: "c", ts: T0 + 99 * 86400_000 }));
    const { index, workers, w } = lane(() => chats);
    index.start(); w().emit("message", { op: "ready", built: false });
    for (let i = 0; i < 60; i++) await tick();
    const posted = () => w().sent.filter(m => m.op === "add").reduce((n, m) => n + m.docs.length, 0);
    expect(posted()).toBe(QUEUE_MAX);
    expect(w().ops()).not.toContain("backfill");
    for (let round = 0; round < 60 && !w().ops().includes("backfill"); round++) {
      for (const m of w().sent.filter(x => x.op === "add" && !x.acked)) { m.acked = true; w().ack(m.batch); }
      for (let i = 0; i < 5; i++) await tick();
    }
    expect([posted(), w().ops().includes("backfill")]).toEqual([10_000, true]);
    // Again, held, and the worker goes mid-wait: that backfill ends; the next worker (not built) backfills anew.
    const second = lane(() => chats);
    second.index.start(); second.w().emit("message", { op: "ready", built: false });
    for (let i = 0; i < 30; i++) await tick();
    second.workers[0]!.emit("exit", 1);
    for (let i = 0; i < 5; i++) await tick();
    expect(second.w().ops()).not.toContain("backfill");
    await new Promise(r => setTimeout(r, 1100));
    second.w().emit("message", { op: "ready", built: false });
    for (let i = 0; i < 30; i++) await tick();
    expect(second.workers).toHaveLength(2);
    expect(second.w().sent.filter(m => m.op === "add").reduce((n, m) => n + m.docs.length, 0)).toBe(QUEUE_MAX);
    // Only the new backfill waits: the old one's wait ended with its worker (no waiter left behind).
    expect((second.index as any).roomWaiters).toHaveLength(1);
    void workers; second.index.close(); index.close();
  });
  it("close sends everything queued before \"close\" (more than one batch); a single batch too", () => {
    vi.useFakeTimers();
    const { index, w } = lane();
    index.start(); w().emit("message", { op: "ready", built: true });
    for (let i = 0; i < QUEUE_MAX + 401; i++) index.record(doc({ text: "x" }));
    vi.advanceTimersByTime(10_000);
    void index.close();
    const sent = w().sent.filter(m => m.op === "add").reduce((n, m) => n + m.docs.length, 0);
    expect([sent, w().ops().at(-1)]).toEqual([QUEUE_MAX + 401, "close"]);
    const one = lane();
    one.index.start(); one.w().emit("message", { op: "ready", built: true });
    one.index.record(doc({ text: "y" }));
    void one.index.close();
    expect(one.w().ops().filter(o => o !== "prune")).toEqual(["add", "close"]);
  });
  it("close, then the next start on the same file: what was queued is there", async () => {
    const s = store();
    const first = new StoreWorker(s);
    const a = new SearchIndex({ path: "/x", retentionDays: 90, chatDocs: () => [], factory: () => first as never, now: () => T0 });
    a.start(); first.ready(true);
    for (let i = 0; i < 450; i++) a.record(doc({ key: `chat:dev:b-q${i}`, text: `queued ${i}` }));
    const closing = a.close();
    first.emit("exit", 0);
    await closing;
    await tick();
    const second = new StoreWorker(s);
    const b = new SearchIndex({ path: "/x", retentionDays: 90, chatDocs: () => [], factory: () => second as never, now: () => T0 });
    b.start(); second.ready(true);
    const r = await b.query({ q: "queued", limit: 200 });
    expect(r.ok && r.value.hits.length).toBe(200);
    expect(s.count()).toBe(450);
    void b.close();
  });
});

/** search-worker's ops over a real SearchStore, in this process (answered on the next microtask, in order). */
class StoreWorker extends EventEmitter {
  adds = 0;
  constructor(private readonly s: SearchStore, private readonly onAdd: (adds: number) => void = () => {}) { super(); }
  ready(built: boolean) { this.emit("message", { op: "ready", built }); }
  postMessage(m: any) { queueMicrotask(() => this.handle(m)); }
  terminate() { return Promise.resolve(0); }
  unref() { return this; }
  private handle(m: any) {
    const reply = (value: unknown) => this.emit("message", { op: "reply", id: m.id, ok: true, value });
    switch (m.op) {
      case "add": this.s.add(m.docs); this.emit("message", { op: "added", batch: m.batch }); this.onAdd(++this.adds); break;
      case "removeInstance": this.s.removeInstance(m.instance); this.emit("message", { op: "removed", instance: m.instance }); break;
      case "query": reply(this.s.search(m.filters)); break;
      case "backfill": reply({ xmsg: 0, tasks: 0 }); break;
      case "prune": reply({ removed: 0, more: false }); break;
      case "markBuilt": this.s.markBuilt(m.now); break;
    }
  }
}

describe("masking before the cut (#2295 review)", () => {
  const pad = (n: number) => "x".repeat(n);
  it("a secret across the TEXT_MAX edge is masked whole: a quoted password, a JSON password", () => {
    const s = store();
    s.add([
      doc({ key: "chat:dev:q", text: `${pad(15976)} password="horse battery staple"` }),
      doc({ key: "chat:dev:j", text: `${pad(15980)} {"password": "correct horse stapler"}` }),
    ]);
    for (const q of ["horse battery", "battery", "correct horse"]) expect(s.search({ q }).hits, q).toEqual([]);
    expect(s.context("chat:dev:q")!.doc.text).not.toMatch(/horse/);
    expect(s.context("chat:dev:j")!.doc.text).not.toMatch(/horse/);
  });
  it("controls: the same secrets inside the kept text are masked; ordinary words at the edge are kept and found", () => {
    const s = store();
    s.add([doc({ key: "chat:dev:in", text: 'deploy password="horse battery staple" now' }),
      doc({ key: "chat:dev:edge", text: `${pad(15980)} nginx upstream` })]);
    expect(s.search({ q: "horse" }).hits).toEqual([]);
    expect(s.search({ q: "deploy" }).hits.map(h => h.key)).toEqual(["chat:dev:in"]);
    expect(s.search({ q: "nginx upstream" }).hits.map(h => h.key)).toEqual(["chat:dev:edge"]);
    expect(s.context("chat:dev:edge")!.doc.text.length).toBeLessThanOrEqual(16_000);
    // The precondition the fix answers: cut first, the quoted secret is no longer recognised.
    expect(maskSecrets(`${pad(15976)} password="horse battery staple"`.slice(0, 16_000))).toMatch(/horse battery/);
  });
});
