/**
 * The web chat's sending state, like Discord's (the user's request): a message shows at once as its own bubble —
 * dimmed, "Sending…" — and turns into the server's copy without ever showing twice; a failed send stays, marked, with
 * Retry and Delete; each file shows its own upload progress (XHR: fetch cannot report it).
 * - the store (chat-store.js), driven directly: reconciliation in every order the stream, the answer, a poll and the
 *   history can come in; sends of a chat go out in order; failure, Retry, Delete; upload progress per file, the CSRF
 *   header, a 401 ending the session as fetch's would;
 * - the thread (chat-thread.js) on the mini DOM: the pending bubble's markup (no data-key: nothing replies to it), its
 *   bars moved in place by progress(), its Retry/Delete; en and zh-TW.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { installDom, type MiniPage } from "./helpers/mini-dom.js";

let dom: MiniPage | null = null;
const offs: Array<() => void> = [];
afterEach(() => { for (const f of offs.splice(0)) f(); dom?.restore(); dom = null; delete (globalThis as any).AgendAuth; });

async function i18n(lang: "en" | "zh-TW" = "en") {
  const { t, setLang } = await import("/assets/app-i18n.js") as any;
  await import("/ui/js/chat-strings.js");
  setLang(lang, { store: false });
  return t;
}
type Answer = { status?: number; body: any } | Promise<{ status?: number; body: any }>;
/** A store on a fake network: `route(path, init)` answers each request; every request is kept. */
async function store(route: (path: string, init: any) => Answer, extra: Record<string, unknown> = {}) {
  dom = installDom({});
  const t = await i18n();
  const { createChatStore } = await import("/ui/js/chat-store.js") as any;
  const calls: Array<{ path: string; method: string; body: any }> = [];
  const fetch = vi.fn(async (path: string, init: any = {}) => {
    calls.push({ path, method: init.method || "GET", body: typeof init.body === "string" ? JSON.parse(init.body) : init.body });
    const a = await route(path, init);
    return { ok: (a.status ?? 200) < 300, status: a.status ?? 200, json: async () => a.body };
  });
  const toasts: string[] = [];
  const s = createChatStore({ fetch, t, toast: (m: string) => toasts.push(m), announce: vi.fn(), now: () => 0, setTimeout, ...extra });
  const changes: Array<[string, string]> = [];
  s.subscribe((instance: string, kind: string) => changes.push([instance, kind]));
  return { s, calls, toasts, changes };
}
function gate<T>() { let open!: (v: T) => void; const promise = new Promise<T>((r) => { open = r; }); return { promise, open }; }
const flush = () => new Promise((r) => setTimeout(r, 0));
/** The server's copy of a sent message, as the stream (with the clientId) or a poll/history (without) brings it. */
const copy = (over: Record<string, unknown> = {}) => ({ instance: "w", boot: "b1", id: 7, sender: "Ann", role: "user", text: "hi", ts: "2026-10-22T10:00:00Z", messageId: "m1", ...over });
const texts = (s: any) => s.threadRows("w").map((m: any) => `${m.outgoing ? `pending:${m.outgoing.state}` : "server"}:${m.text}`);

describe("the store: one bubble at once, then the server's copy — never both", () => {
  it("shown at once as sending; the stream's copy (its clientId) before the answer replaces it in that same redraw", async () => {
    const reply = gate<{ body: any }>();
    const { s, calls, changes } = await store((path) => (path === "/ui/send" ? reply.promise : { body: {} }));
    s.setDraft("w", "hi");
    const going = s.send("w");
    expect([texts(s), s.state.drafts.w]).toEqual([["pending:sending:hi"], ""]);
    const clientId = calls.at(-1)!.body.clientId;
    expect(clientId).toMatch(/^c[0-9a-f]{24}$/);
    changes.length = 0;
    s.ingest(copy({ clientId }));
    expect([texts(s), changes.filter(([, k]) => k === "msgs").length]).toEqual([["server:hi"], 1]);
    reply.open({ body: { sent: true, messageId: "m1" } }); await going;
    expect(texts(s), "the late answer brings nothing back").toEqual(["server:hi"]);
  });
  it("the answer first: shown as sent (no longer dimmed); a poll's copy — no clientId, the same messageId — replaces it", async () => {
    const { s } = await store((path) => (path === "/ui/send" ? { body: { sent: true, messageId: "m1" } } : { body: {} }));
    s.setDraft("w", "hi"); await s.send("w");
    expect(texts(s)).toEqual(["pending:sent:hi"]);
    s.ingest(copy());
    expect(texts(s)).toEqual(["server:hi"]);
  });
  it("…or the history read when the chat opens (by messageId)", async () => {
    const { s } = await store((path) => (path === "/ui/send" ? { body: { sent: true, messageId: "m1" } } : path.startsWith("/ui/history") ? { body: { messages: [copy()] } } : { body: {} }));
    s.setDraft("w", "hi"); await s.send("w");
    await s.openHistory("w");
    expect(texts(s)).toEqual(["server:hi"]);
  });
  it("someone else's message with the same words is not taken for it (only its clientId or messageId)", async () => {
    const { s } = await store((path) => (path === "/ui/send" ? { body: { sent: true, messageId: "m1" } } : { body: {} }));
    s.setDraft("w", "hi"); await s.send("w");
    s.ingest(copy({ messageId: "other", sender: "Bob", id: 8 }));
    expect(texts(s)).toEqual(["server:hi", "pending:sent:hi"]);
  });
  it("a chat's sends go out in order, one at a time: a second waits (queued) behind the first", async () => {
    const first = gate<{ body: any }>();
    const answers = [first.promise, Promise.resolve({ body: { sent: true, messageId: "m2" } })];
    const { s, calls } = await store((path) => (path === "/ui/send" ? answers.shift()! : { body: {} }));
    s.setDraft("w", "one"); const a = s.send("w");
    s.setDraft("w", "two"); s.send("w");
    expect([texts(s), calls.filter((c) => c.path === "/ui/send").map((c) => c.body.message)]).toEqual([["pending:sending:one", "pending:queued:two"], ["one"]]);
    first.open({ body: { sent: true, messageId: "m1" } }); await a;
    await flush();
    expect([texts(s), calls.filter((c) => c.path === "/ui/send").map((c) => c.body.message)]).toEqual([["pending:sent:one", "pending:sent:two"], ["one", "two"]]);
  });
});

describe("the store: a failed send stays, with Retry, Put back and Delete", () => {
  it("failed with the reason (said once); Retry is the same bubble, the same clientId; Delete lets it go", async () => {
    let answer: any = { status: 503, body: { error: "offline" } };
    const { s, calls, toasts } = await store((path) => (path === "/ui/send" ? answer : { body: {} }));
    s.setDraft("w", "hi"); await s.send("w");
    const [e] = s.state.outgoing.w;
    expect([texts(s), e.outgoing.error, toasts]).toEqual([["pending:failed:hi"], "offline", ["offline"]]);
    answer = { body: { sent: true, messageId: "m1" } };
    await s.retryOutgoing("w", e.clientId);
    const sends = calls.filter((c) => c.path === "/ui/send");
    expect([texts(s), sends.map((c) => c.body.clientId)]).toEqual([["pending:sent:hi"], [e.clientId, e.clientId]]);
    answer = { status: 503, body: { error: "offline" } };
    s.setDraft("w", "bye"); await s.send("w");
    const failed = s.state.outgoing.w.find((x: any) => x.text === "bye");
    s.deleteOutgoing("w", e.clientId);                                       // only a failed one can be deleted
    s.deleteOutgoing("w", failed.clientId);
    expect(texts(s)).toEqual(["pending:sent:hi"]);
  });
  it("Put back: the bubble goes; its text before what is typed now, its files and its reply back in the composer (failed only)", async () => {
    const { s } = await store((path) => (path === "/ui/send" ? { status: 503, body: { error: "offline" } } : { body: {} }));
    const quote = { boot: "b1", id: 3, sender: "Ann", text: "deploy?" };
    s.state.replies.w = quote;
    s.setDraft("w", "fix the typo"); s.state.pendingFiles.w = [file("a.png", 10)];
    s.send("w");
    const [e] = s.state.outgoing.w;
    s.putBackOutgoing("w", e.clientId);                                      // still going: nothing to put back
    await flush(); await flush();
    expect(e.outgoing.state).toBe("failed");
    s.setDraft("w", "and this");
    s.putBackOutgoing("w", e.clientId);
    expect([texts(s), s.state.drafts.w, s.state.pendingFiles.w.map((f: any) => f.name), s.state.replies.w]).toEqual([[], "fix the typo\nand this", ["a.png"], quote]);
  });
  it("a request that never reached the server is said in the page's words, not the browser's ('Failed to fetch')", async () => {
    const { s } = await store((path) => { if (path === "/ui/send") throw new TypeError("Failed to fetch"); return { body: {} }; });
    s.setDraft("w", "hi"); await s.send("w");
    expect(s.state.outgoing.w[0].outgoing.error).toBe("it did not reach AgEnD — check the connection");
  });
  it("a localized reason is said in the page's words (chat.sendFailure_<reason>)", async () => {
    const { s } = await store((path) => (path === "/ui/send" ? { status: 503, body: { error: "raw", reason: "delivery_changed" } } : { body: {} }));
    s.setDraft("w", "hi"); await s.send("w");
    expect(s.state.outgoing.w[0].outgoing.error).not.toBe("raw");
  });
});

/** An XHR that reports its upload progress as the test moves it; one per upload, kept in `made`. */
function fakeXhr(made: any[]) {
  return class {
    upload: any = {}; status = 0; responseText = ""; headers: Record<string, string> = {}; url = ""; body: any;
    onload: any; onerror: any; onabort: any;
    constructor() { made.push(this); }
    open(_m: string, url: string) { this.url = url; }
    setRequestHeader(k: string, v: string) { this.headers[k] = v; }
    send(body: any) { this.body = body; }
    progress(loaded: number, total: number) { this.upload.onprogress?.({ lengthComputable: true, loaded, total }); }
    answer(status: number, body: any) { this.status = status; this.responseText = JSON.stringify(body); this.onload?.(); }
  };
}
const file = (name: string, size: number, type = "image/png") => ({ name, size, type });

describe("the store: each file shows its own upload progress", () => {
  it("per file, as XHR reports it; the CSRF header the page's fetch would add; then the message names them", async () => {
    const made: any[] = [];
    (globalThis as any).AgendAuth = { csrf: async () => "csrf-1" };
    const { s, calls } = await store((path) => (path === "/ui/send" ? { body: { sent: true, messageId: "m1" } } : { body: {} }), { XMLHttpRequest: fakeXhr(made) });
    s.state.pendingFiles.w = [file("a.png", 100), file("b.png", 200)];
    s.setDraft("w", "pics");
    const going = s.send("w");
    await flush(); await flush();
    const [e] = s.state.outgoing.w;
    made[0].progress(40, 100);
    expect(e.files.map((f: any) => [f.name, f.state, f.loaded])).toEqual([["a.png", "uploading", 40], ["b.png", "waiting", 0]]);
    expect([made[0].url, made[0].headers["X-Agend-CSRF"], made[0].headers["X-Agend-Filename"]]).toEqual(["/ui/upload?instance=w", "csrf-1", "a.png"]);
    made[0].answer(200, { id: "1".repeat(32) });
    await flush(); await flush();
    made[1].progress(150, 200);
    expect(e.files.map((f: any) => [f.state, f.loaded])).toEqual([["done", 100], ["uploading", 150]]);
    made[1].answer(200, { id: "2".repeat(32) });
    await going;
    expect([e.outgoing.state, calls.at(-1)!.body.attachments]).toEqual(["sent", ["1".repeat(32), "2".repeat(32)]]);
  });
  it("an upload that fails marks that file; Retry uploads only what is not uploaded yet", async () => {
    const made: any[] = [];
    const { s, calls } = await store((path) => (path === "/ui/send" ? { body: { sent: true, messageId: "m1" } } : { body: {} }), { XMLHttpRequest: fakeXhr(made) });
    s.state.pendingFiles.w = [file("a.png", 10), file("b.png", 10)];
    const going = s.send("w");
    await flush(); await flush();
    made[0].answer(200, { id: "1".repeat(32) });
    await flush(); await flush();
    made[1].onerror();
    await going;
    const [e] = s.state.outgoing.w;
    expect([e.outgoing.state, e.files.map((f: any) => f.state), calls.some((c) => c.path === "/ui/send")]).toEqual(["failed", ["done", "failed"], false]);
    const again = s.retryOutgoing("w", e.clientId);
    await flush(); await flush();
    expect(made.length, "only b.png again").toBe(3);
    made[2].answer(200, { id: "2".repeat(32) });
    await again;
    expect([e.outgoing.state, calls.at(-1)!.body.attachments]).toEqual(["sent", ["1".repeat(32), "2".repeat(32)]]);
  });
  it("a 401 on an upload ends the session as fetch's would (AgendAuth.unauthorized)", async () => {
    const made: any[] = [];
    const unauthorized = vi.fn();
    (globalThis as any).AgendAuth = { csrf: async () => null, unauthorized };
    const { s } = await store(() => ({ body: {} }), { XMLHttpRequest: fakeXhr(made) });
    s.state.pendingFiles.w = [file("a.png", 10)];
    const going = s.send("w");
    await flush(); await flush();
    made[0].answer(401, { error: "no session" });
    await going;
    expect([unauthorized.mock.calls.length, s.state.outgoing.w[0].outgoing.state]).toEqual([1, "failed"]);
  });
});

describe("the thread: the pending bubble", () => {
  async function threadWith(rows: any[], opts: Record<string, unknown> = {}, lang: "en" | "zh-TW" = "en") {
    dom = installDom({});
    const t = await i18n(lang);
    const { createThread } = await import("/ui/js/chat-thread.js") as any;
    const doc = dom.document as any;
    const list = doc.createElement("div"), scroller = doc.createElement("div"); scroller.append(list); doc.body.append(scroller);
    const thread = createThread(list, scroller, { t, tf: t, isUser: (x: any) => x.role === "user", serverNow: () => 0, onJump() {}, onEmpty() {}, ...opts });
    thread.render(rows);
    offs.push(() => thread.dispose());
    return { list, thread };
  }
  const pending = (state: string, over: Record<string, unknown> = {}) => ({ boot: "out", id: 1, instance: "w", role: "user", sender: "You", text: "hello <b>there</b>",
    clientId: "c" + "a".repeat(24), outgoing: { state, ...(state === "failed" ? { error: "offline" } : {}) }, files: [], ...over });
  it("sending: dimmed (out-sending), 'Sending…', busy; its text escaped; no data-key (nothing replies to it or links to it)", async () => {
    const { list } = await threadWith([pending("sending")]);
    const el = list.querySelector(".msg.out");
    expect([el.className, el.getAttribute("aria-busy"), el.getAttribute("data-key"), el.querySelector(".out-state").textContent, el.querySelector(".md").innerHTML.includes("<b>")])
      .toEqual(["msg user out out-sending", "true", null, "Sending…", false]);
  });
  it("failed: the reason on a straight bar (.lbar), Retry, Put back and Delete, which go to the store by clientId", async () => {
    const retryOutgoing = vi.fn(), deleteOutgoing = vi.fn(), putBackOutgoing = vi.fn();
    const { list, thread } = await threadWith([pending("failed")], { retryOutgoing, deleteOutgoing, putBackOutgoing });
    const bar = list.querySelector(".out-note");
    expect([bar.className, bar.getAttribute("role"), bar.querySelector(".out-error").textContent]).toEqual(["out-note lbar", "alert", "Not sent: offline"]);
    thread.onClick({ target: bar.querySelector('[data-act="retryOut"]') });
    thread.onClick({ target: bar.querySelector('[data-act="deleteOut"]') });
    thread.onClick({ target: bar.querySelector('[data-act="putBackOut"]') });
    const id = [["c" + "a".repeat(24)]];
    expect([[...bar.querySelectorAll("button")].map((b: any) => b.textContent), retryOutgoing.mock.calls, deleteOutgoing.mock.calls, putBackOutgoing.mock.calls])
      .toEqual([["Retry send", "Put back", "Delete"], id, id, id]);
  });
  it("each file: its own bar and percentage, moved in place by progress() — the node is not redrawn", async () => {
    const files = [{ name: "a.png", size: 100, type: "image/png", url: "blob:a", loaded: 0, total: 100, state: "uploading" }, { name: "b.pdf", size: 50, type: "application/pdf", url: null, loaded: 0, total: 50, state: "waiting" }];
    const row = pending("sending", { files });
    const { list, thread } = await threadWith([row]);
    const node = list.querySelector(".msg.out");
    files[0].loaded = 40; thread.progress();
    const rows = () => [...node.querySelectorAll(".out-file")].map((f: any) => [f.dataset.state, f.querySelector(".out-bar").getAttribute("aria-valuenow"), f.querySelector(".out-pct").textContent]);
    expect([rows(), node.querySelector(".out-pic").getAttribute("src"), !!node.querySelector(".out-file:nth-child(2) .out-doc")]).toEqual([[["uploading", "40", "40%"], ["waiting", "0", "waiting"]], "blob:a", true]);
    files[0].state = "done"; files[1].state = "failed"; thread.progress();
    expect([rows(), list.querySelector(".msg.out") === node]).toEqual([[["done", "100", "100%"], ["failed", "0", "failed"]], true]);
  });
  it("zh-TW: its words in the page's language", async () => {
    const { list } = await threadWith([pending("failed")], {}, "zh-TW");
    expect([list.querySelector(".out-error").textContent, [...list.querySelectorAll(".out-note button")].map((b: any) => b.textContent)]).toEqual(["沒有送出：offline", ["重試傳送", "放回輸入框", "刪除"]]);
  });
});
