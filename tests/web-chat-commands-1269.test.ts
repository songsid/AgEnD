/**
 * #1269 (3)+(4): the web chat's commands and quick actions — the page side.
 * - "/" opens the palette (filtered as typed; ↑/↓, Tab completes, Esc closes); Enter on a command line runs it through
 *   POST /ui/command, anything else starting with "/" is sent as a message, as before.
 * - The answer shows above the composer (text, refusal, or a list to choose from — the /model and /effort picks).
 * - /clear asks in the app's dialog; only a yes, while the chat that asked is still on screen, confirms it.
 * - One command at a time per instance. Quick actions: model/effort chips in the header, Compact / Clear… at 70%.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fire, settle } from "./helpers/mini-dom.js";
import type { AppPage } from "./helpers/app-harness.js";
// @ts-expect-error — a page module: plain JS, no declarations (as the other ../src/ui imports)
import { CHAT_COMMANDS, needsArgument, paletteFor, parseCommandLine } from "../src/ui/chat-commands.js";

describe("the palette's rules (pure)", () => {
  it("opens on a leading '/' and only while the command's name is typed; filters by prefix", () => {
    expect(paletteFor("/")!.map((c: { name: string }) => c.name)).toEqual(CHAT_COMMANDS.map((c: { name: string }) => c.name));
    expect(paletteFor("/co")!.map((c: { name: string }) => c.name)).toEqual(["compact"]);
    expect(paletteFor("/zz")).toEqual([]);
    for (const d of ["", "hi", "/compact ", "/compact x", " /co", "/Co", "a/co"]) expect(paletteFor(d), JSON.stringify(d)).toBeNull();
  });
  it("a command line: known name + optional arguments; unknown names and non-commands are messages", () => {
    expect(parseCommandLine("/compact keep the notes")).toEqual({ command: "compact", args: "keep the notes" });
    expect(parseCommandLine("  /ctx  ")).toEqual({ command: "ctx", args: "" });
    expect(parseCommandLine("/steer line one\nline two")).toEqual({ command: "steer", args: "line one\nline two" });
    for (const d of ["/raw ls", "/status", "/foo", "hello /ctx", "/ctxx", "/compact-x", "/"]) expect(parseCommandLine(d), d).toBeNull();
    expect([needsArgument("btw"), needsArgument("steer"), needsArgument("save"), needsArgument("compact"), needsArgument("ctx")]).toEqual([true, true, true, false, false]);
  });
});

// ── the page ──
function fakeStream() {
  const subs = new Map<string, Array<(d: any) => void>>();
  return { on(n: string, fn: (d: any) => void) { subs.set(n, [...(subs.get(n) ?? []), fn]); return () => {}; }, emit(n: string, d: any) { for (const fn of subs.get(n) ?? []) fn(d); } };
}
function fetchMock() {
  const calls: Array<{ path: string; method: string; body?: any }> = [];
  const mock = {
    calls, respond: (_p: string, _b?: any): unknown => ({}),
    fn: async (path: string, o: { method?: string; body?: unknown } = {}) => {
      const body = typeof o.body === "string" ? JSON.parse(o.body) : o.body;          // an upload's body is the File
      calls.push({ path, method: o.method ?? "GET", body });
      const value = await mock.respond(path, body);
      return { ok: true, status: 200, json: async () => value };
    },
  };
  return mock;
}
const inst = (name: string, over: Record<string, unknown> = {}) => ({ name, status: "running", state: "idle", backend: "claude-code", ...over });

describe("the chat's commands (the real page modules)", () => {
  const pages: AppPage[] = [];
  afterEach(async () => { for (const pg of pages.splice(0)) { await pg.unmount(); pg.restore(); } delete (globalThis as any).confirm; });

  async function chatPage(instOver: Record<string, unknown> = {}) {
    vi.resetModules();
    const harness = await import("./helpers/app-harness.js");
    const p = harness.page({ storage: { agend_tour_done: "1" } });       // no first-visit tour (its Esc comes first)
    pages.push(p);
    const app = await import("/assets/app-store.js" as string);
    const panel = await import("/ui/js/panel-chat.js" as string);
    const fx = fetchMock();
    fx.respond = (path: string) => (path.startsWith("/ui/history") ? { messages: [] } : {});
    const stream = fakeStream();
    stream.on("status", app.applyStatus);
    panel.boot({ stream, boot: null, deps: { fetch: fx.fn, toast() {}, setTimeout: () => 1 } });
    stream.emit("status", { uptime: 1, instances: [inst("w", instOver)] });
    await p.mount(harness.h("main", { id: "main" }, harness.h(panel.ChatPanel, { route: { panel: "chat", instance: "w" }, navKey: "chat|w" })));
    await settle();
    const box = () => p.root.querySelector("#msgIn");
    const type = async (text: string) => { box().value = text; fire(box(), "input"); await settle(); };
    const key = async (k: string, init: Record<string, unknown> = {}) => { const e = fire(box(), "keydown", { key: k, ...init }); await settle(); return e; };
    const commands = () => fx.calls.filter((c) => c.path === "/ui/command");
    const sends = () => fx.calls.filter((c) => c.path === "/ui/send");
    return { p, fx, box, type, key, commands, sends, panel, card: () => p.root.querySelector(".cmd-card"), options: () => p.root.querySelectorAll(".cmd-palette li[role=option]") };
  }

  it("'/' opens the palette; typing filters; ↑/↓ moves; Tab completes; Esc closes it (and is not a Stop)", async () => {
    const c = await chatPage();
    await c.type("/");
    expect(c.options().map((o: any) => o.querySelector(".cmd-name").textContent.split(" ")[0])).toEqual(CHAT_COMMANDS.map((x: { name: string }) => `/${x.name}`));
    expect(c.box().getAttribute("aria-expanded")).toBe("true");
    await c.type("/c");
    expect(c.options().map((o: any) => o.id)).toEqual(["cmd-ctx", "cmd-compact", "cmd-clear", "cmd-cancel"]);
    expect(c.box().getAttribute("aria-activedescendant")).toBe("cmd-ctx");
    await c.key("ArrowDown");
    expect(c.box().getAttribute("aria-activedescendant")).toBe("cmd-compact");
    await c.key("ArrowUp"); await c.key("ArrowUp");
    expect(c.box().getAttribute("aria-activedescendant")).toBe("cmd-cancel");          // wraps
    await c.key("Tab");
    expect(c.box().value).toBe("/cancel");
    await c.type("/zz");
    expect(c.p.root.querySelector(".cmd-none").textContent).toContain("sends it as a message");
    await c.type("/co");
    expect(!!c.p.root.querySelector(".cmd-palette")).toBe(true);
    const esc = await c.key("Escape");
    expect(esc.defaultPrevented, "Esc is the palette's, not the reply's Stop").toBe(true);
    expect(!!c.p.root.querySelector(".cmd-palette"), "closed by Esc").toBe(false);
    await c.type("/c");
    expect(!!c.p.root.querySelector(".cmd-palette"), "opens again as the draft changes").toBe(true);
  });

  it("Enter runs a command line through /ui/command and clears the draft; the answer shows above the composer", async () => {
    const c = await chatPage();
    c.fx.respond = (path: string, body: any) => (path === "/ui/command" ? { text: `ran ${body.command} ${body.args ?? ""}` } : {});
    await c.type("/compact keep the API notes");
    await c.key("Enter");
    expect(c.commands().map((x) => x.body)).toEqual([{ instance: "w", command: "compact", args: "keep the API notes" }]);
    expect(c.box().value).toBe("");
    expect(c.card().querySelector(".cmd-text").textContent).toBe("ran compact keep the API notes");
    expect(c.sends()).toEqual([]);
    fire(c.card().querySelector(".icon-btn"), "click"); await settle();
    expect(!!c.card()).toBe(false);
    await c.type("/ctx"); await c.key("Enter");                                        // the palette's own pick, exactly typed
    expect(c.commands().at(-1)!.body).toEqual({ instance: "w", command: "ctx" });
  });

  it("not a command: '/foo', '/raw …' and a command beside a file go as messages; '/btw' alone completes, it does not run", async () => {
    const c = await chatPage();
    await c.type("/foo bar"); await c.key("Enter");
    await c.type("/raw ls"); await c.key("Enter");
    expect(c.sends().map((x) => x.body.message)).toEqual(["/foo bar", "/raw ls"]);
    expect(c.commands()).toEqual([]);
    // A file waiting beside it: the message (and its file) is what goes, not a command.
    c.fx.respond = (path: string) => (path.startsWith("/ui/upload") ? { id: "e".repeat(32) } : {});
    c.panel.store.addFiles("w", [new File(["x"], "a.txt", { type: "text/plain" })]);
    await settle();
    expect(c.panel.store.state.pendingFiles.w.map((f: File) => f.name)).toEqual(["a.txt"]);
    await c.type("/ctx"); await c.key("Enter"); await settle(8);
    expect(!!c.p.root.querySelector(".cmd-palette"), "no palette beside a file").toBe(false);
    expect(c.commands()).toEqual([]);
    expect(c.sends().at(-1)!.body).toMatchObject({ message: "/ctx", attachments: ["e".repeat(32)] });
    await c.type("/btw"); await c.key("Enter");
    expect(c.box().value).toBe("/btw ");
    expect(c.commands()).toEqual([]);
    await c.type("/steer   "); await c.key("Enter");                              // past the palette: still nothing to steer with
    expect(c.box().value).toBe("/steer ");
    expect(c.commands()).toEqual([]);
  });

  for (const yes of [true, false]) {
    it(`/clear: asked in the app's dialog; ${yes ? "a yes confirms with the server's token" : "a no sends nothing more"}`, async () => {
      const c = await chatPage();
      c.fx.respond = (path: string, body: any) => (path !== "/ui/command" ? {} : body.confirm ? { text: "Clear sent" } : { confirm: { token: "f".repeat(32), message: "Clear w's conversation?" } });
      const asked: string[] = [];
      (globalThis as any).confirm = (m: string) => { asked.push(m); return yes; };
      await c.type("/clear"); await c.key("Enter"); await settle(8);
      expect(asked).toHaveLength(1);
      expect(asked[0]).toContain("Clear w's conversation?");
      expect(c.commands().map((x) => x.body.confirm ?? null)).toEqual(yes ? [null, "f".repeat(32)] : [null]);
      if (yes) expect(c.card().querySelector(".cmd-text").textContent).toBe("Clear sent");
      else expect(!!c.card()).toBe(false);
    });
  }

  it("/clear: a yes given after the chat went does nothing", async () => {
    const c = await chatPage();
    c.fx.respond = (path: string, body: any) => (path !== "/ui/command" ? {} : body.confirm ? { text: "Clear sent" } : { confirm: { token: "f".repeat(32), message: "Clear?" } });
    let gone: Promise<void> | null = null;
    (globalThis as any).confirm = () => { gone = c.p.unmount(); return true; };
    await c.type("/clear"); await c.key("Enter"); await settle(8);
    await gone;
    expect(c.commands().map((x) => x.body.confirm ?? null)).toEqual([null]);
  });

  it("/model with nothing after it: the list to choose from; a choice runs /model <id>; a refusal shows as one", async () => {
    const c = await chatPage();
    c.fx.respond = (path: string, body: any) => (path !== "/ui/command" ? {} : body.args ? { text: `Model set to ${body.args}` }
      : { choices: { current: "a", options: [{ id: "a", label: "✓ Alpha" }, { id: "b", label: "Beta" }] } });
    await c.type("/model"); await c.key("Enter");
    const opts = c.card().querySelectorAll(".cmd-choices .btn");
    expect(opts.map((b: any) => [b.textContent, b.getAttribute("aria-current")])).toEqual([["✓ Alpha", "true"], ["Beta", null]]);
    fire(opts[1], "click"); await settle();
    expect(c.commands().at(-1)!.body).toEqual({ instance: "w", command: "model", args: "b" });
    expect(c.card().querySelector(".cmd-text").textContent).toBe("Model set to b");
    c.fx.respond = () => ({ error: "/save is not available over the public link." });
    await c.type("/save notes.md"); await c.key("Enter");
    expect(c.card().getAttribute("role")).toBe("alert");
    expect(c.card().className).toContain("bad");
  });

  it("one command at a time: a second Enter while one is out sends nothing", async () => {
    const c = await chatPage();
    let release!: () => void;
    c.fx.respond = (path: string) => (path === "/ui/command" ? new Promise((r) => { release = () => r({ text: "ok" }); }) : {});
    await c.type("/ctx"); await c.key("Enter");
    await c.type("/ctx"); await c.key("Enter");
    expect(c.commands()).toHaveLength(1);
    expect(c.card().querySelector(".wait").textContent).toBe("Running /ctx…");
    release(); await settle();
    expect(c.card().querySelector(".cmd-text").textContent).toBe("ok");
  });

  it("the header shows the model and effort it runs; each opens its list (/model, /effort)", async () => {
    const c = await chatPage({ context_pct: 69.4, model: "claude-opus-5-5", effort: "high" });
    expect(!!c.p.root.querySelector(".quick-actions"), "69% is under the line").toBe(false);
    const chips = c.p.root.querySelectorAll(".hd-chip");
    expect(chips.map((b: any) => b.textContent)).toEqual(["claude-opus-5-5", "high"]);
    fire(chips[0], "click"); await settle();
    fire(chips[1], "click"); await settle();
    expect(c.commands().map((x) => x.body)).toEqual([{ instance: "w", command: "model" }, { instance: "w", command: "effort" }]);
  });

  it("quick actions: Compact and Clear… once context is 70% used", async () => {
    const c = await chatPage({ context_pct: 82 });
    const qa = c.p.root.querySelector(".quick-actions");
    expect(qa.querySelector(".qa-ctx").textContent).toBe("Context 82% used");
    fire(qa.querySelectorAll(".btn")[0], "click"); await settle();
    expect(c.commands().map((x) => x.body)).toEqual([{ instance: "w", command: "compact" }]);
  });
});
