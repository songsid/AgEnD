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
    const timers: Array<{ fn: () => void; ms: number }> = [];
    panel.boot({ stream, boot: null, deps: { fetch: fx.fn, toast() {}, setTimeout: (fn: () => void, ms: number) => { timers.push({ fn, ms }); return timers.length; } } });
    stream.emit("status", { uptime: 1, instances: [inst("w", instOver)] });
    await p.mount(harness.h("main", { id: "main" }, harness.h(panel.ChatPanel, { route: { panel: "chat", instance: "w" }, navKey: "chat|w" })));
    await settle();
    const box = () => p.root.querySelector("#msgIn");
    const type = async (text: string) => { box().value = text; fire(box(), "input"); await settle(); };
    const key = async (k: string, init: Record<string, unknown> = {}) => { const e = fire(box(), "keydown", { key: k, ...init }); await settle(); return e; };
    const commands = () => fx.calls.filter((c) => c.path === "/ui/command");
    const sends = () => fx.calls.filter((c) => c.path === "/ui/send");
    /** Run the timers set for `ms` so far (each once). */
    const elapse = async (ms: number) => { for (const t of timers.splice(0).filter((x) => { const due = x.ms === ms; if (!due) timers.push(x); return due; })) t.fn(); await settle(); };
    return { p, fx, box, type, key, commands, sends, panel, stream, timers, elapse, card: () => p.root.querySelector(".cmd-card"), options: () => p.root.querySelectorAll(".cmd-palette li[role=option]") };
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

  it("/backend (#1806): one choice at a time, each with its question; the last asks in the dialog, labelled as the switch it is", async () => {
    const c = await chatPage();
    const ui = await import("/assets/ui-confirm.js" as string);
    (globalThis as any).confirm = undefined;                                   // drive the app's own dialog
    c.fx.respond = (path: string, body: any) => (path !== "/ui/command" ? {}
      : body.confirm ? { text: "w now runs codex" }
      : !body.args ? { choices: { prompt: "Now: claude-code\nSelect a backend:", current: "claude-code", options: [{ id: "claude-code", label: "✓ claude-code" }, { id: "codex", label: "codex" }] } }
      : body.args === "codex" ? { choices: { prompt: "Model for codex:", current: null, options: [{ id: "codex default", label: "default" }, { id: "codex gpt-5.5", label: "GPT-5.5" }] } }
      : { confirm: { token: "f".repeat(32), message: "Switch w to codex?" } });
    const pick = async (label: string) => {
      fire([...c.card().querySelectorAll(".cmd-choices button")].find((b: any) => b.textContent === label), "click");
      await settle(8);
    };
    await c.type("/backend"); await c.key("Enter");
    expect(c.card().querySelector("pre.cmd-text").textContent).toBe("Now: claude-code\nSelect a backend:");
    await pick("codex");
    expect(c.card().querySelector("pre.cmd-text").textContent).toBe("Model for codex:");
    await pick("GPT-5.5");
    const asked = ui.confirmStore.get().queue;
    expect(asked.map((q: any) => [q.title, q.message, q.confirmLabel])).toEqual([["/backend", "Switch w to codex?", "Switch and restart"]]);
    ui.answerConfirm(asked[0].id, true); await settle(8);
    expect(c.commands().map((x) => [x.body.args ?? null, x.body.confirm ?? null]))
      .toEqual([[null, null], ["codex", null], ["codex gpt-5.5", null], ["codex gpt-5.5", "f".repeat(32)]]);
    expect(c.card().querySelector(".cmd-text").textContent).toBe("w now runs codex");
  });

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

  it("#1476 review: a command line typed while one is still out stays in the composer (nothing sent, nothing lost)", async () => {
    const c = await chatPage();
    let release!: () => void;
    c.fx.respond = (path: string) => (path === "/ui/command" ? new Promise((r) => { release = () => r({ text: "ok" }); }) : {});
    await c.type("/ctx"); await c.key("Enter");
    expect(c.box().value, "an admitted command consumes its line").toBe("");
    await c.type("/steer please preserve this complete directive"); await c.key("Enter");
    expect(c.commands()).toHaveLength(1);
    expect(c.box().value).toBe("/steer please preserve this complete directive");
    release(); await settle();
    await c.key("Enter");                                                      // now free: it runs, and is consumed
    expect(c.commands().map((x) => x.body.command)).toEqual(["ctx", "steer"]);
    expect(c.box().value).toBe("");
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

  it("the store's single flight covers the buttons too: a quick action while a command is out sends nothing", async () => {
    const c = await chatPage({ context_pct: 82 });
    let release!: () => void;
    c.fx.respond = (path: string) => (path === "/ui/command" ? new Promise((r) => { release = () => r({ text: "ok" }); }) : {});
    await c.type("/ctx"); await c.key("Enter");
    c.panel.store.runCommand("w", "compact", "");                         // a chip's click, straight to the store
    await settle();
    expect(c.commands().map((x) => x.body.command)).toEqual(["ctx"]);
    release(); await settle();
  });

  it("quick actions: Compact and Clear… once context is 70% used", async () => {
    const c = await chatPage({ context_pct: 82 });
    const qa = c.p.root.querySelector(".quick-actions");
    expect(qa.querySelector(".qa-ctx").textContent).toBe("Context 82% used");
    fire(qa.querySelectorAll(".btn")[0], "click"); await settle();
    expect(c.commands().map((x) => x.body)).toEqual([{ instance: "w", command: "compact" }]);
  });

  // ── Board 003648ac: a sent /compact is followed to its end; an answer that only says "sent" leaves by itself ──
  const phase = (c: { card: () => any }) => c.card()?.querySelector(".cmd-phase")?.textContent ?? null;
  const frame = (compact?: unknown) => ({ uptime: 2, instances: [inst("w", compact ? { compact } : {}), inst("v", { compact: { id: "a".repeat(16), state: "done" } })] });

  it("/compact followed: Compacting…, then compacted when the status frame says so (its own watch only), then it leaves", async () => {
    const c = await chatPage();
    c.fx.respond = (path: string) => (path === "/ui/command" ? { text: "🗜️ Compact command sent (`/compact`).", follow: { kind: "compact", id: "a".repeat(16) } } : {});
    await c.type("/compact"); await c.key("Enter"); await settle();
    expect(c.card().querySelector("pre.cmd-text").textContent).toBe("🗜️ Compact command sent (`/compact`).");
    expect(phase(c)).toBe("Compacting…");
    c.stream.emit("status", frame({ id: "b".repeat(16), state: "done" })); await settle();
    c.stream.emit("status", frame({ id: "a".repeat(16), state: "running" })); await settle();
    await c.elapse(8000); await c.elapse(12000);
    expect(phase(c)).toBe("Compacting…");
    c.stream.emit("status", frame({ id: "a".repeat(16), state: "done" })); await settle();
    expect(phase(c)).toBe("✅ Conversation compacted");
    await c.elapse(6000);
    expect(c.card()).toBeNull();
    c.stream.emit("status", frame({ id: "a".repeat(16), state: "done" })); await settle();
    expect(c.card()).toBeNull();
  });

  it("/compact that never ends: the fleet's timeout is said, and the card stays until dismissed", async () => {
    const c = await chatPage();
    c.fx.respond = (path: string) => (path === "/ui/command" ? { text: "sent", follow: { kind: "compact", id: "a".repeat(16) } } : {});
    await c.type("/compact"); await c.key("Enter"); await settle();
    c.stream.emit("status", frame({ id: "a".repeat(16), state: "timeout" })); await settle();
    expect(phase(c)).toBe("No sign that compaction finished within 10 minutes — check the agent's own chat.");
    for (const ms of [6000, 8000, 12000, 11 * 60_000]) await c.elapse(ms);
    expect(phase(c)).toContain("No sign");
    fire(c.card().querySelector(".icon-btn"), "click"); await settle();
    expect(c.card()).toBeNull();
  });

  it("/compact the fleet can no longer follow (lost): said, and the card stays", async () => {
    const c = await chatPage();
    c.fx.respond = (path: string) => (path === "/ui/command" ? { text: "sent", follow: { kind: "compact", id: "a".repeat(16) } } : {});
    await c.type("/compact"); await c.key("Enter"); await settle();
    c.stream.emit("status", frame({ id: "a".repeat(16), state: "lost" })); await settle();
    expect(phase(c)).toBe("Can't follow this compaction: the command did not reach the agent, or the agent stopped or changed backend.");
    for (const ms of [6000, 8000, 12000, 11 * 60_000]) await c.elapse(ms);
    expect(phase(c)).toContain("Can't follow");
  });

  it("board 907c7899: kiro said it did not compact (too short, or stopped): said, and the card stays", async () => {
    const c = await chatPage();
    c.fx.respond = (path: string) => (path === "/ui/command" ? { text: "sent", follow: { kind: "compact", id: "a".repeat(16) } } : {});
    await c.type("/compact"); await c.key("Enter"); await settle();
    c.stream.emit("status", frame({ id: "a".repeat(16), state: "not_compacted" })); await settle();
    expect(phase(c)).toBe("kiro did not compact the conversation: it was too short, or the compaction was stopped.");
    for (const ms of [6000, 8000, 12000, 11 * 60_000]) await c.elapse(ms);
    expect(phase(c)).toContain("did not compact");
  });

  it("/compact with no word from the fleet at all: the page's own limit says so, and the card stays", async () => {
    const c = await chatPage();
    c.fx.respond = (path: string) => (path === "/ui/command" ? { text: "sent", follow: { kind: "compact", id: "a".repeat(16) } } : {});
    await c.type("/compact"); await c.key("Enter"); await settle();
    const armed = c.timers.length;
    c.stream.emit("status", frame({ id: "a".repeat(16), state: "running" })); await settle();     // no new deadline per frame
    expect(c.timers.length).toBe(armed);
    await c.elapse(11 * 60_000 - 1);
    expect(phase(c)).toBe("Compacting…");
    await c.elapse(11 * 60_000);
    expect(phase(c)).toContain("No sign");
    await c.elapse(6000);
    expect(phase(c)).toContain("No sign");
  });

  it("/compact on a backend whose end can't be seen: never called done — said so, and the card leaves", async () => {
    const c = await chatPage();
    c.fx.respond = (path: string) => (path === "/ui/command" ? { text: "sent", follow: { kind: "compact", id: null } } : {});
    await c.type("/compact"); await c.key("Enter"); await settle();
    expect(phase(c)).toBe("This backend does not report when compaction ends.");
    c.stream.emit("status", frame({ id: "a".repeat(16), state: "done" })); await settle();
    expect(phase(c)).toBe("This backend does not report when compaction ends.");
    await c.elapse(8000);
    expect(!!c.card()).toBe(true);
    await c.elapse(12000);
    expect(c.card()).toBeNull();
  });

  it("an answer the server marks sent (/cancel that stopped a reply) leaves by itself", async () => {
    const c = await chatPage();
    c.fx.respond = (path: string) => (path === "/ui/command" ? { text: "🛑 Sent cancel to w.", sent: true } : {});
    await c.type("/cancel"); await c.key("Enter"); await settle();
    expect(!!c.card()).toBe(true);
    await c.elapse(6000);
    expect(!!c.card()).toBe(true);
    await c.elapse(8000);
    expect(c.card()).toBeNull();
  });

  it("review P2-6: the server's own refusal worded as text (/cancel with nothing running) stays", async () => {
    // The body exactly as runWebCommand answers it.
    const { runWebCommand } = await import("../src/web-commands.js");
    const answer = (await runWebCommand({ scope: () => "fleet", cancel: () => false, t: (k: string) => k } as any, { instance: "w", command: "cancel" }, { publicLink: false })).body;
    expect(answer).toEqual({ text: "cancel.not_running" });
    const c = await chatPage();
    c.fx.respond = (path: string) => (path === "/ui/command" ? answer : {});
    await c.type("/cancel"); await c.key("Enter"); await settle();
    for (const ms of [6000, 8000, 12000, 11 * 60_000]) await c.elapse(ms);
    expect(c.card().querySelector(".cmd-text").textContent).toBe("cancel.not_running");
  });

  it.each(["steer x", "btw x", "pause", "wake", "save notes.md"])("an answer not marked sent (/%s) stays until dismissed", async (command) => {
    const c = await chatPage();
    c.fx.respond = (path: string) => (path === "/ui/command" ? { text: "sent" } : {});
    await c.type(`/${command}`); await c.key("Enter"); await settle();
    for (const ms of [6000, 8000, 12000]) await c.elapse(ms);
    expect(!!c.card()).toBe(true);
  });

  it("a card's own timer never takes the next card: /cancel, then /ctx before it would have left", async () => {
    const c = await chatPage();
    c.fx.respond = (path: string, body: any) => (path === "/ui/command" ? (body.command === "ctx" ? { text: "Context: 40%" } : { text: "sent", sent: true }) : {});
    await c.type("/cancel"); await c.key("Enter"); await settle();
    await c.type("/ctx"); await c.key("Enter"); await settle();
    await c.elapse(8000);
    expect(c.card().querySelector(".cmd-text").textContent).toBe("Context: 40%");
  });

  it("/clear's 'sent' leaves by itself too", async () => {
    const c = await chatPage();
    c.fx.respond = (path: string, body: any) => (path !== "/ui/command" ? {} : body.confirm ? { text: "Clear sent", sent: true } : { confirm: { token: "f".repeat(32), message: "Clear?" } });
    (globalThis as any).confirm = () => true;
    await c.type("/clear"); await c.key("Enter"); await settle(8);
    expect(c.card().querySelector(".cmd-text").textContent).toBe("Clear sent");
    await c.elapse(8000);
    expect(c.card()).toBeNull();
  });

  it.each([["ctx", { text: "Context: 40%" }], ["compact", { error: "Instance not connected" }], ["model", { choices: { current: "a", options: [{ id: "a", label: "A" }] } }], ["model opus", { text: "Model set" }], ["cancel", { error: "Not running" }]] as const)(
    "an answer to read, a refusal or a list stays (/%s)", async (command, answer) => {
      const c = await chatPage();
      c.fx.respond = (path: string) => (path === "/ui/command" ? answer : {});
      await c.type(`/${command}`); await c.key("Enter"); await settle();
      for (const ms of [6000, 8000, 12000, 11 * 60_000]) await c.elapse(ms);
      expect(!!c.card()).toBe(true);
      expect(phase(c)).toBeNull();
    });
});
