/**
 * #1990 PR 3: on the web, a status line's other instance opens that instance's chat, and a prompt's instance opens its
 * terminal View — in-app links the router takes (no target, no reload). The server sends ranges of the text with a
 * route, keeps them with a status line only (live, in the history on disk, read back validated), and the client turns
 * only a route of its own table into a link. An agent's or a person's message never links.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installDom } from "./helpers/mini-dom.js";
import { WebChatHistory, type StoredWebChatMessage } from "../src/web-chat-history.js";
import { renderPlaceRefs, placeRef, webRoute, webTextLinks } from "../src/topic-link.js";
import { outboundHandlers } from "../src/outbound-handlers.js";
import { FleetManager } from "../src/fleet-manager.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setLocale, t as serverT } from "../src/locale.js";

vi.mock("../src/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child() { return this; } }),
}));

type Served = any;
let textLinkSegments: any, parseRoute: any, createThread: any, t: any;
beforeAll(async () => {
  ({ textLinkSegments, parseRoute } = await (import("/assets/app-route.js") as Promise<Served>));
  // @ts-expect-error — a JS module of the app, with no types
  await import("../src/ui/chat-render.js");
  ({ createThread } = await (import("/ui/js/chat-thread.js") as Promise<Served>));
  await (import("/ui/js/chat-strings.js") as Promise<Served>);
  ({ t } = await (import("/assets/app-i18n.js") as Promise<Served>));
});
const dirs: string[] = [];
afterEach(() => { setLocale("en"); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); });

describe("routes and their validation", () => {
  it("webRoute: an instance's chat or View, as the client's table parses it", () => {
    expect(webRoute("chat", "dev-a")).toBe("/ui/chat/dev-a");
    expect(webRoute("view", "研一官網-t1")).toBe(`/view/${encodeURIComponent("研一官網-t1")}`);
    expect(parseRoute(webRoute("chat", "研一官網-t1"))).toEqual({ panel: "chat", instance: "研一官網-t1" });
    for (const bad of ["", "a/b", "..", "a..b", ".", "x\u0001", "a\\b", "x".repeat(129)]) expect(webRoute("chat", bad), bad).toBeUndefined();
  });
  it("webTextLinks (server): only in-text, ordered ranges with an app route; the rest dropped", () => {
    const text = "alice → bob: hi";
    expect(webTextLinks([{ offset: 0, length: 5, url: "/ui/chat/alice" }], text)).toEqual([{ offset: 0, length: 5, url: "/ui/chat/alice" }]);
    for (const bad of [
      [{ offset: 0, length: 5, url: "https://evil.example/" }], [{ offset: 0, length: 5, url: "/ui/fleet" }],
      [{ offset: 0, length: 5, url: "/ui/chat/a?x=1" }], [{ offset: 0, length: 5, url: "//evil/ui/chat/a" }],
      [{ offset: 10, length: 50, url: "/ui/chat/a" }], [{ offset: -1, length: 2, url: "/ui/chat/a" }], [{ offset: 0, length: 0, url: "/ui/chat/a" }],
      [{ offset: 0, length: 5, url: "/ui/chat/%E0%A4%A" }], "nope", null,
    ]) expect(webTextLinks(bad, text), JSON.stringify(bad)).toBeUndefined();
    // overlapping: the first stands
    expect(webTextLinks([{ offset: 0, length: 5, url: "/ui/chat/a" }, { offset: 3, length: 3, url: "/ui/chat/b" }], text)).toEqual([{ offset: 0, length: 5, url: "/ui/chat/a" }]);
  });
  it("textLinkSegments (client): links only for its own chat/View routes; text kept whole", () => {
    const text = "alice → bob: hi";
    expect(textLinkSegments(text, [{ offset: 0, length: 5, url: "/ui/chat/alice" }, { offset: 8, length: 3, url: "/view/bob" }])).toEqual([
      { text: "alice", href: "/ui/chat/alice" }, { text: " → " }, { text: "bob", href: "/view/bob" }, { text: ": hi" },
    ]);
    for (const bad of [
      [{ offset: 0, length: 5, url: "https://evil.example/ui/chat/a" }], [{ offset: 0, length: 5, url: "javascript:alert(1)" }],
      [{ offset: 0, length: 5, url: "/ui/fleet/tasks" }], [{ offset: 0, length: 5, url: "/ui/chat/a%2Fb" }],
      [{ offset: 0, length: 99, url: "/ui/chat/a" }], [{ offset: 0, length: 5, url: "/settings" }],
    ]) expect(textLinkSegments(text, bad), JSON.stringify(bad)).toEqual([{ text }]);
    expect(textLinkSegments("", undefined)).toEqual([{ text: "" }]);
    expect(textLinkSegments(text, null)).toEqual([{ text }]);
  });
  it("#2008 review: the client rebuilds the href, refuses traversal / another host / overlap, and stops at 16", () => {
    expect(textLinkSegments("abc", [{ offset: 0, length: 3, url: "/ui/chat/%61%62" }])).toEqual([{ text: "abc", href: "/ui/chat/ab" }]);
    for (const url of ["/ui/chat/../x", "//evil.com/ui/chat/a", "/ui/chat/a/../../x", "/ui/chat/%2e%2e", "/ui/chat/a?x=1", "/ui/chat/a#x", "/ui/chat/a b"]) {
      expect(textLinkSegments("abcdef", [{ offset: 0, length: 3, url }]), url).toEqual([{ text: "abcdef" }]);
    }
    expect(textLinkSegments("abcdef", [{ offset: 0, length: 3, url: "/ui/chat/a" }, { offset: 2, length: 2, url: "/ui/chat/b" }]))
      .toEqual([{ text: "abc", href: "/ui/chat/a" }, { text: "def" }]);
    const many = Array.from({ length: 20 }, (_, i) => ({ offset: i, length: 1, url: "/ui/chat/a" }));
    const text = "x".repeat(20);
    expect(textLinkSegments(text, many).filter((sg: any) => sg.href)).toHaveLength(16);
    expect(webTextLinks(many, text)).toHaveLength(16);
  });
});

describe("the history keeps a status line's links — and nobody else's", () => {
  const links = [{ offset: 0, length: 5, url: "/ui/chat/alice" }];
  it("live: a status line keeps them; an agent's or a person's message never", () => {
    const h = new WebChatHistory({ boot: "aa" });
    expect(h.record({ instance: "w", sender: "alice", role: "status", text: "alice → w: hi", ts: "t", links }).links).toEqual(links);
    expect(h.record({ instance: "w", sender: "w", role: "agent", text: "alice → w: hi", ts: "t", links }).links).toBeUndefined();
    expect(h.record({ instance: "w", sender: "u", role: "user", text: "alice → w: hi", ts: "t", links }).links).toBeUndefined();
    expect(h.record({ instance: "w", sender: "alice", role: "status", text: "x", ts: "t", links }).links).toBeUndefined();   // out of the text
  });
  it("through the fleet's SSE emitter: recorded with the line (what /ui/history, /ui/poll and a replay send)", () => {
    const dir = mkdtempSync(join(tmpdir(), "links-web-1990-")); dirs.push(dir);
    const fm = new FleetManager(dir) as any;
    fm.emitSseEvent("message", { instance: "w", sender: "alice", role: "status", text: "alice → w: hi", ts: "t", links });
    expect(fm.webChatHistory.list("w").map((m: any) => m.links)).toEqual([links]);
  });
  it("on disk: kept with a status line, read back validated", () => {
    let rows: StoredWebChatMessage[] = [];
    const h = new WebChatHistory({ boot: "aa", store: { schedule: (_i, snap) => { rows = snap(); }, remove: async () => {} } });
    h.record({ instance: "w", sender: "alice", role: "status", text: "alice → w: hi", ts: "t", links });
    expect(rows[0].links).toEqual(links);
    const next = new WebChatHistory({ boot: "bb" });
    next.restore("w", [rows[0], { ...rows[0], id: 2, links: [{ offset: 0, length: 5, url: "https://evil.example/" }] }, { ...rows[0], id: 3, role: "agent" }]);
    expect(next.list("w").map(m => m.links)).toEqual([links, undefined, undefined]);
  });
});

describe("the server: cross-instance web lines and prompts carry the links", () => {
  async function send(message: string, sender = "alice") {
    const web: any[] = [];
    const ctx = {
      fleetConfig: {
        channel: { type: "telegram", group_id: "-1001" }, defaults: {},
        instances: { alice: { working_directory: "/w/a", topic_id: 11 }, bob: { working_directory: "/w/b", topic_id: 22 } },
      },
      adapter: { sendText: async (chatId: string) => ({ messageId: "m", chatId }) },
      instanceIpcClients: new Map([["bob", { connected: true }]]),
      sessionRegistry: new Map(), lifecycle: { daemons: new Map() }, getInstanceStatus: () => "running",
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      admitDurableDelivery: () => ({ deliveryId: "d1", state: "queued", duplicate: false }),
      emitSseEvent: (_e: string, data: any) => web.push(data),
    };
    let error: unknown;
    await outboundHandlers.get("send_to_instance")!(ctx as never, { instance_name: "bob", message, request_kind: "task" } as never,
      (_r, err) => { error = err; }, { instanceName: sender } as never);
    expect(error).toBeUndefined();
    return web;
  }
  it("bob's line links alice's chat; alice's line links bob's", async () => {
    const web = await send("please look");
    const bob = web.find(w => w.instance === "bob"), alice = web.find(w => w.instance === "alice");
    expect(bob.text).toBe("alice → bob:\nplease look");
    expect(bob.links).toEqual([{ offset: 0, length: 5, url: "/ui/chat/alice" }]);
    expect(alice.links).toEqual([{ offset: 8, length: 3, url: "/ui/chat/bob" }]);
  });
  it("#2008 review: a sender that is not a fleet instance (a session) gets no link", async () => {
    const web = await send("hi", "outside-session");
    expect(web.find(w => w.instance === "bob").links).toBeUndefined();
  });
  it("an agent's message cannot add a link", async () => {
    const web = await send(`see ${placeRef({ kind: "instance", name: "bob" }, "HERE")}`);
    const bob = web.find(w => w.instance === "bob");
    expect(bob.links).toEqual([{ offset: 0, length: 5, url: "/ui/chat/alice" }]);
    expect(bob.text).not.toMatch(/[\uE000-\uE002]/);
  });
  it("a prompt on the dashboard: the instance's name opens its View", async () => {
    setLocale("en");
    const dir = mkdtempSync(join(tmpdir(), "links-web-1990-")); dirs.push(dir);
    const fm = new FleetManager(dir) as any;
    const adapter = { id: "telegram", type: "telegram", sendText: vi.fn(async () => ({ messageId: "m" })), notifyAlert: vi.fn(async (chatId: string) => ({ messageId: "a1", chatId })) };
    const cfg = { id: "telegram", type: "telegram", mode: "topic", group_id: "-1001234567890" };
    fm.adapter = adapter; fm.adapters.set("telegram", adapter);
    fm.worlds.set("telegram", { id: "telegram", type: "telegram", adapter, channelConfig: cfg, groupId: "-1001234567890" });
    fm.fleetConfig = { defaults: {}, channels: [cfg], channel: cfg, instances: { general: { topic_id: 1, general_topic: true }, alpha: { topic_id: 30 } } };
    fm.daemons.set("general", {});
    const events: any[] = [];
    fm.emitSseEvent = (event: string, data: unknown) => { if (event === "prompt") events.push(data); };
    await fm.notifyNormalExit("alpha");
    expect(events[0].text).toBe(serverT("exit.general_notice", "alpha"));
    const at = events[0].text.indexOf("alpha");
    expect(events[0].links).toEqual([{ offset: at, length: 5, url: "/view/alpha" }]);
    expect(fm.listWebPrompts()[0].links).toEqual(events[0].links);
  });
});

describe("the client draws them as in-app links", () => {
  function thread() {
    const dom = installDom({});
    const doc = (globalThis as any).document;
    const scroller = doc.createElement("div"); const list = doc.createElement("div");
    scroller.append(list); doc.body.append(scroller);
    const th = createThread(list, scroller, {
      t: (k: string) => t(k), tf: (k: string, ...a: unknown[]) => t(k, ...a), isUser: (x: any) => x.role === "user", onJump() {}, onEmpty() {},
      setPreviewOptIn() {}, copyText: async () => true, download() {}, toggleWrap() {},
    });
    return { dom, list, th };
  }
  const line = (links: unknown, text = "alice → w:\n<b>hi</b>") => ({ boot: "x", id: 1, instance: "w", sender: "alice", role: "status", text, ts: "2026-01-01T00:00:00Z", links });

  it("a status line: the name is an <a> with the route and no target; the rest stays escaped text", () => {
    const { dom, list, th } = thread();
    try {
      th.render([line([{ offset: 0, length: 5, url: "/ui/chat/alice" }])]);
      const a = list.querySelector(".st-text a.st-link");
      expect(a.getAttribute("href")).toBe("/ui/chat/alice");
      expect(a.getAttribute("target")).toBeNull();
      expect(a.textContent).toBe("alice");
      expect(list.querySelector(".st-text").textContent).toBe("alice → w:\n<b>hi</b>");
      expect(list.querySelector(".st-text b")).toBeNull();
    } finally { dom.restore(); }
  });
  it("a click on it is the app's navigation (the thread's own click handling leaves it alone)", async () => {
    const { dom, list, th } = thread();
    try {
      th.render([line([{ offset: 0, length: 5, url: "/ui/chat/alice" }])]);
      const { fire } = await import("./helpers/mini-dom.js");
      const { startRouter, navStore } = await (import("/assets/app-nav.js") as Promise<Served>);
      startRouter((globalThis as any).window);
      const ev = fire(list.querySelector("a.st-link"), "click", { button: 0 }) as any;
      expect([ev.defaultPrevented, navStore.get().route, (globalThis as any).location.pathname]).toEqual([true, { panel: "chat", instance: "alice" }, "/ui/chat/alice"]);
    } finally { dom.restore(); }
  });
  it("#2008 review: a display name with HTML in the link stays text — no element, attribute or entity is made of it", () => {
    const { dom, list, th } = thread();
    try {
      const name = `<img src=x onerror=alert(1)>"'&amp;`;
      th.render([line([{ offset: 0, length: name.length, url: "/ui/chat/alice" }], `${name} → w:\nhi`)]);
      const a = list.querySelector(".st-text a.st-link");
      expect([a.textContent, a.getAttribute("href"), a.getAttribute("data-trust"), a.attributes.length]).toEqual([name, "/ui/chat/alice", "link", 3]);
      expect(list.querySelector(".st-text img")).toBeNull();
      expect(list.querySelector(".st-text").textContent).toBe(`${name} → w:\nhi`);
    } finally { dom.restore(); }
  });
  it("a link the client's table does not take is plain text", () => {
    const { dom, list, th } = thread();
    try {
      th.render([line([{ offset: 0, length: 5, url: "https://evil.example/" }])]);
      expect(list.querySelector(".st-text a")).toBeNull();
      expect(list.querySelector(".st-text").textContent).toBe("alice → w:\n<b>hi</b>");
    } finally { dom.restore(); }
  });
  it("an agent's message with links is never linked by them", () => {
    const { dom, list, th } = thread();
    try {
      th.render([{ ...line([{ offset: 0, length: 5, url: "/ui/chat/alice" }], "alice says hi"), role: "agent", sender: "w" }]);
      expect(list.querySelector("a.st-link")).toBeNull();
    } finally { dom.restore(); }
  });
});
