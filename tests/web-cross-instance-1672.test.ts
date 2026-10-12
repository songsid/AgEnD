/**
 * #1672: cross-instance messages (send_to_instance, delegate_task, request_information, report_result) appear in each
 * instance's web chat as a muted status line, following the same `cross_instance_visibility` as the topics (#1302):
 * full → the whole text, summary → one line, hidden → nothing; report/update stay silent on the target's side; General
 * instances are skipped. Not gated on a topic or a chat platform. Role `status` — never an agent's (no preview card) or
 * a person's message — recorded in the web chat history (#1565), so it is there again after a restart.
 *
 * The real handlers run against a recording adapter and a recording durable admission: no daemon, CLI, tmux or real
 * fleet (bd0c88aa).
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { outboundHandlers } from "../src/outbound-handlers.js";
import { setLocale } from "../src/locale.js";
import { installDom } from "./helpers/mini-dom.js";

const homes: string[] = [];
beforeEach(() => setLocale("en"));
afterEach(() => { vi.unstubAllEnvs(); for (const d of homes.splice(0)) rmSync(d, { recursive: true, force: true }); });

const GROUP = "-100777";
const LABEL = "alice → bob";
const LONG = `First line of the request.\n\nSecond paragraph — ${"x".repeat(150)}`;
type Kind = "task" | "query" | "report" | "update" | undefined;
interface WebLine { instance: string; sender: string; role: string; text: string }

async function send(opts: {
  tool?: "send_to_instance" | "delegate_task" | "request_information" | "report_result";
  defaults?: Record<string, unknown>;
  sender?: Record<string, unknown>;
  target?: Record<string, unknown>;
  kind?: Kind;
  message?: string;
  webOnly?: boolean;
  emit?: (event: string, data: unknown) => void;
}) {
  const posts: Array<{ threadId: string; text: string }> = [];
  const web: WebLine[] = [];
  const events: string[] = [];
  const adapter = {
    sendText: async (_chatId: string, text: string, o?: { threadId?: string }) => { posts.push({ threadId: String(o?.threadId), text }); return { messageId: "m", chatId: GROUP }; },
  };
  const ctx = {
    fleetConfig: {
      ...(opts.webOnly ? {} : { channel: { type: "telegram", group_id: GROUP } }),
      defaults: { ...(opts.defaults ?? {}) },
      instances: {
        alice: { working_directory: "/w/a", ...(opts.webOnly ? {} : { topic_id: 11 }), ...(opts.sender ?? {}) },
        bob: { working_directory: "/w/b", ...(opts.webOnly ? {} : { topic_id: 22 }), ...(opts.target ?? {}) },
      },
    },
    adapter: opts.webOnly ? null : adapter,
    instanceIpcClients: new Map([["bob", { connected: true }]]),
    sessionRegistry: new Map(),
    lifecycle: { daemons: new Map() },
    getInstanceStatus: () => "running",
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    admitDurableDelivery: () => ({ deliveryId: "d1", state: "queued", duplicate: false }),
    queueMirrorMessage: () => {},
    emitSseEvent: (event: string, data: unknown) => {
      events.push(event);
      if (event === "message") web.push(data as WebLine);
      opts.emit?.(event, data);
    },
  };
  const message = opts.message ?? LONG;
  const tool = opts.tool ?? "send_to_instance";
  const args = tool === "send_to_instance" ? { instance_name: "bob", message, ...(opts.kind ? { request_kind: opts.kind } : {}) }
    : tool === "delegate_task" ? { target_instance: "bob", task: message }
    : tool === "request_information" ? { target_instance: "bob", question: message }
    : { target_instance: "bob", summary: message, correlation_id: "cid-1" };
  let error: unknown;
  await outboundHandlers.get(tool)!(ctx as never, args as never, (_r, err) => { error = err; }, { instanceName: "alice" } as never);
  expect(error).toBeUndefined();
  await new Promise(r => setImmediate(r));
  for (const line of web) expect(line.role, "a cross-instance line is a status line, never an agent's or a person's").toBe("status");
  return {
    web, events, message,
    alice: web.filter(w => w.instance === "alice").map(w => w.text),
    bob: web.filter(w => w.instance === "bob").map(w => w.text),
    topics: posts,
  };
}

describe("#1672: the web chat shows cross-instance messages like the topics", () => {
  it("full task: the whole message in the target's chat and in the sender's chat", async () => {
    const r = await send({ kind: "task" });
    expect(r.bob).toEqual([`${LABEL}:\n${LONG}`]);
    expect(r.alice).toEqual([`${LABEL}:\n${LONG}`]);
    expect(r.web.every(w => w.sender === "alice")).toBe(true);
    // The topics still get their own posts, unchanged.
    expect(r.topics.map(p => p.threadId).sort()).toEqual(["11", "22"]);
  });

  it("delegate_task and request_information reach both chats; report_result only the sender's", async () => {
    for (const tool of ["delegate_task", "request_information"] as const) {
      const r = await send({ tool, message: "do it" });
      expect([r.alice, r.bob], tool).toEqual([[`${LABEL}:\ndo it`], [`${LABEL}:\ndo it`]]);
    }
    const report = await send({ tool: "report_result", message: "done" });
    expect([report.alice, report.bob]).toEqual([[`${LABEL}:\ndone`], []]);
  });

  it("summary: one line in each chat", async () => {
    const r = await send({ defaults: { cross_instance_visibility: "summary" }, kind: "task" });
    const preview = `${LABEL}: First line of the request. Second paragraph — ${"x".repeat(100 - "First line of the request. Second paragraph — ".length - 1)}…`;
    expect([r.alice, r.bob]).toEqual([[preview], [preview]]);
  });

  it("each chat follows its own instance's mode; hidden → nothing at all", async () => {
    const mixed = await send({ kind: "task", target: { cross_instance_visibility: "hidden" } });
    expect([mixed.alice.length, mixed.bob]).toEqual([1, []]);
    const hidden = await send({ defaults: { cross_instance_visibility: "hidden" }, kind: "task" });
    expect(hidden.events).toEqual([]);
  });

  it("report and update: only the sender's chat, in every mode", async () => {
    for (const kind of ["report", "update"] as const) {
      for (const mode of ["full", "summary"]) {
        const r = await send({ defaults: { cross_instance_visibility: mode }, kind });
        expect([r.alice.length, r.bob], `${kind} ${mode}`).toEqual([1, []]);
      }
    }
  });

  it("a General instance's chat gets nothing — as target, or as sender", async () => {
    const toGeneral = await send({ kind: "task", target: { general_topic: true } });
    expect([toGeneral.alice.length, toGeneral.bob]).toEqual([1, []]);
    const fromGeneral = await send({ kind: "task", sender: { general_topic: true } });
    expect([fromGeneral.alice, fromGeneral.bob.length]).toEqual([[], 1]);
  });

  it("a web-only fleet (no chat platform, no topics) still gets the lines; a topic-less instance too", async () => {
    const r = await send({ kind: "task", webOnly: true });
    expect([r.alice, r.bob]).toEqual([[`${LABEL}:\n${LONG}`], [`${LABEL}:\n${LONG}`]]);
    expect(r.topics).toEqual([]);
    const topicless = await send({ kind: "task", target: { topic_id: undefined } });
    expect(topicless.bob).toEqual([`${LABEL}:\n${LONG}`]);
    expect(topicless.topics.map(p => p.threadId)).toEqual(["11"]);
  });

  it("a status line with an html fence is still a status line (the role never comes from the text)", async () => {
    const r = await send({ kind: "task", message: "```html\n<b>hi</b>\n```" });
    expect(r.web.map(w => w.role)).toEqual(["status", "status"]);
  });
});

describe("#1672: it is in the web chat history, and there again after a restart", () => {
  it("the real fleet records the line; a new fleet on the same home restores it as a status line", async () => {
    const h = mkdtempSync(join(tmpdir(), "agend-test-1672-")); homes.push(h);
    vi.stubEnv("AGEND_HOME", h);
    for (const name of ["alice", "bob"]) mkdirSync(join(h, "workspaces", name), { recursive: true });
    const { FleetManager } = await import("../src/fleet-manager.js");
    const fleet = { defaults: {}, instances: { alice: { working_directory: "/w/a" }, bob: { working_directory: "/w/b" } } };
    const start = () => { const fm = new FleetManager(h) as any; clearInterval(fm.sessionPruneTimer); fm.fleetConfig = fleet; fm.restoreWebChat(fleet); return fm; };
    const fm1 = start();
    await send({ kind: "task", webOnly: true, message: "ship it", emit: (e, d) => fm1.emitSseEvent(e, d) });
    expect(fm1.webChatHistory.list("bob").map((m: any) => [m.role, m.text])).toEqual([["status", `${LABEL}:\nship it`]]);
    await fm1.webChatStore?.flush();
    const fm2 = start();
    expect(fm2.webChatHistory.list("bob").map((m: any) => [m.role, m.sender, m.text])).toEqual([["status", "alice", `${LABEL}:\nship it`]]);
    expect(fm2.webChatHistory.list("alice").map((m: any) => m.role)).toEqual(["status"]);
    await fm2.webChatStore?.flush();
    await new Promise(r => setTimeout(r, 50));
  });
});

type Served = any;
let createThread: any, createChatStore: any, t: any, setLang: any;
beforeAll(async () => {
  // @ts-expect-error — a JS module of the app, with no types
  await import("../src/ui/chat-render.js");
  ({ createThread } = await (import("/ui/js/chat-thread.js") as Promise<Served>));
  ({ createChatStore } = await (import("/ui/js/chat-store.js") as Promise<Served>));
  await (import("/ui/js/chat-strings.js") as Promise<Served>);
  ({ t, setLang } = await (import("/assets/app-i18n.js") as Promise<Served>));
});

const status = (id: number, text: string, sender = "claude-fable") => ({ boot: "x", id, instance: "w", sender, role: "status", text, ts: "2026-01-01T00:00:00Z" });

function thread() {
  const dom = installDom({});
  const doc = (globalThis as any).document;
  const scroller = doc.createElement("div"); const list = doc.createElement("div");
  scroller.append(list); doc.body.append(scroller);
  // The app's own isUser reads the sender: a name not starting with "agend" counts as a person.
  const th = createThread(list, scroller, {
    t: (k: string) => t(k), tf: (k: string, ...a: unknown[]) => t(k, ...a), isUser: (x: any) => !String(x.sender).startsWith("agend") && x.sender !== "w", onJump() {}, onEmpty() {},
    setPreviewOptIn() {}, copyText: async () => true, download() {}, toggleWrap() {},
  });
  return { dom, list, th };
}

describe("#1672: the thread draws a status line muted, as plain text", () => {
  it("not a person's bubble, not an agent's: plain text — no Markdown, no preview card, no html", () => {
    const { dom, list, th } = thread();
    try {
      th.render([status(1, "alice → w:\n**bold** <i>raw</i>\n```html\n<b>card</b>\n```")]);
      const msg = list.querySelector(".msg");
      expect([msg.classList.contains("status"), msg.classList.contains("user"), msg.classList.contains("agent")]).toEqual([true, false, false]);
      expect(list.querySelector(".st-text").textContent).toBe("alice → w:\n**bold** <i>raw</i>\n```html\n<b>card</b>\n```");
      for (const sel of [".html-card", ".md", "strong", "i", "b", "pre", ".codeblock", ".rb-row"]) expect(list.querySelector(sel), sel).toBeNull();
      expect(list.querySelector(".st-more")).toBeNull();
    } finally { dom.restore(); }
  });

  it("a long one is folded: many lines → Show all N lines; one long line → Show more; the toggle opens and closes it", () => {
    const { dom, list, th } = thread();
    try {
      const lines = Array.from({ length: 9 }, (_, i) => `line ${i}`).join("\n");
      th.render([status(1, lines), status(2, "y".repeat(700)), status(3, "short")]);
      const msgs = [...list.querySelectorAll(".msg.status")] as any[];
      expect(msgs.map(m => m.classList.contains("folded"))).toEqual([true, true, false]);
      const [many, wide] = msgs.map(m => m.querySelector(".st-more"));
      expect([many.textContent, wide.textContent]).toEqual(["Show all 9 lines", "Show more"]);
      th.onClick({ target: many });
      expect([msgs[0].classList.contains("folded"), many.textContent]).toEqual([false, "Show less"]);
      th.onClick({ target: many });
      expect([msgs[0].classList.contains("folded"), many.textContent]).toEqual([true, "Show all 9 lines"]);
      th.onClick({ target: wide }); th.onClick({ target: wide });
      expect([msgs[1].classList.contains("folded"), wide.textContent]).toEqual([true, "Show more"]);
    } finally { dom.restore(); }
  });

  it("the fold reads in English and in zh-TW", () => {
    try {
      expect([t("chat.showMore"), t("chat.showLess"), t("chat.showAll", 9)]).toEqual(["Show more", "Show less", "Show all 9 lines"]);
      setLang("zh-TW");
      expect([t("chat.showMore"), t("chat.showLess"), t("chat.showAll", 9)]).toEqual(["顯示更多", "收合", "展開全部 9 行"]);
    } finally { setLang("en"); }
  });
});

describe("#1672: a status line is not announced as a reply", () => {
  it("the store announces an agent reply, never a status line", () => {
    const announced: string[] = [];
    const store = createChatStore({ announce: (s: string) => announced.push(s), t: (k: string, ...a: unknown[]) => `${k}:${a.join(",")}` } as never);
    store.setCurrent("w");
    store.ingest(status(1, "alice → w: hi", "agend-x"));
    expect(announced).toEqual([]);
    store.ingest({ boot: "x", id: 2, instance: "w", sender: "agend-x", role: "agent", text: "reply", ts: "2026-01-01T00:00:00Z" });
    expect(announced).toEqual(["chat.a11yReplied:agend-x"]);
  });
});
