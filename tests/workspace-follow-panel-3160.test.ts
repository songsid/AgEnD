/**
 * #3160: Follow agent in the Files & changes panel (the real modules, over a faked /ui/workspace):
 * - off by default: no follow request at all; on: asks for this turn's steps while the panel is open;
 * - an edit opens the file with the changed lines highlighted (from that file's diff); a read highlights its range;
 *   a search shows the folder with the entry marked; a hidden file is listed in the strip, never opened;
 * - this turn's steps in a strip; anything you do yourself pauses Follow (newer steps are kept, not shown) until you
 *   resume, which shows the newest; closing the panel stops asking; a backend without it says so; changedLines.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fire, installDom, settle } from "./helpers/mini-dom.js";
import { h, page, type AppPage } from "./helpers/app-harness.js";

let panel: any, pp: any, wsp: any, i18n: any, store: any;
let current: AppPage | null = null;
const realFetch = globalThis.fetch;
beforeAll(async () => {
  // @ts-expect-error — a JS module of the app, with no types
  await import("../src/ui/chat-render.js");
  // @ts-expect-error — a JS module of the app, with no types
  await import("../src/ui/preview.js");
  const base = installDom({ storage: { agend_tour_done: "1" } });
  // @ts-expect-error — a JS module of the app, with no types
  panel = await import("../src/ui/panel-chat.js");
  // @ts-expect-error — a JS module of the app, with no types
  pp = await import("../src/ui/preview-panel.js");
  // @ts-expect-error — a JS module of the app, with no types
  wsp = await import("../src/ui/workspace-panel.js");
  i18n = await import("/assets/app-i18n.js");
  store = await import("/assets/app-store.js");
  panel.boot({ stream: { on() {} }, boot: { dashboardOrigin: "http://127.0.0.1:19280", previewOrigin: "", previewBoot: "", previewReason: "" }, deps: { fetch: () => new Promise(() => {}) } });
  store.appStore.set({ ready: true, instances: [{ name: "w", status: "running" }] });
  base.restore();
  Object.assign(wsp.FOLLOW_TIMING, { pollMs: 20, applyMs: 0, changesMs: 10 });
});
afterEach(async () => {
  globalThis.fetch = realFetch;
  pp.closePanel();
  await current?.unmount();
  panel.store.state.msgs.w = [];
  i18n.setLang("en", { store: false });
  current?.restore();
  current = null;
});

const P = (path: string, extra: Record<string, unknown> = {}) => ({ path, hidden: false, dir: false, ...extra });
const step = (seq: number, kind: string, paths: unknown[], extra: Record<string, unknown> = {}) => ({ seq, at: seq, kind, tool: kind === "edit" ? "Edit" : "Read", paths, exact: true, ...extra });
const CHANGES = { repo: true, branch: "main", hiddenCount: 0, cut: { files: false, bytes: false }, files: [], patch: "" };
let calls: string[] = [];
let follow: { supported: boolean; running: boolean; scope?: string; turn: number; steps: unknown[] }[] = [];
function serve(defaultFollow: { supported: boolean; running: boolean; turn: number; steps: unknown[]; scope?: string } = { supported: true, running: true, turn: 1, steps: [] }) {
  calls = [];
  let last = 0, lastTurn = defaultFollow.turn, lastScope = defaultFollow.scope;
  globalThis.fetch = vi.fn(async (url: string) => {
    calls.push(url);
    const q = new URL(url, "http://x").searchParams, op = q.get("op"), path = q.get("path") ?? "";
    let status = 200, body: unknown;
    if (op === "follow") {
      const next = follow.shift() ?? { ...defaultFollow, scope: lastScope, turn: lastTurn, steps: [] };   // no news: the same scope/turn
      lastTurn = next.turn; lastScope = next.scope;
      for (const s of next.steps as { seq: number }[]) last = Math.max(last, s.seq);
      body = { ...next, last };
    } else if (op === "changes") body = CHANGES;
    else if (op === "list") body = { path, cut: false, entries: path === "src" ? [{ name: "a.ts", type: "file", size: 30, hidden: false }, { name: "b.ts", type: "file", size: 9, hidden: false }]
      : [{ name: "src", type: "dir", size: null, hidden: false }, { name: ".env", type: "file", size: 9, hidden: true }] };
    else if (op === "file" && path === "src/a.ts") body = { kind: "text", path, size: 30, text: "l1\nl2\nl3\nl4\nl5\nl6\n" };
    else if (op === "file" && path === "src/b.ts") body = { kind: "text", path, size: 9, text: "b1\nb2\n" };
    else if (op === "diff" && path === "src/a.ts") body = { path, repo: true, tooLarge: false, binary: false, patch: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -2,3 +2,3 @@\n l2\n-old\n+l3\n l4\n" };
    else { status = 404; body = { error: "not_found" }; }
    return { ok: status === 200, status, json: async () => body };
  }) as any;
}
async function chat() {
  current = page({ url: "http://127.0.0.1:19280/ui/chat/w", storage: { agend_tour_done: "1" } });
  panel.store.state.msgs.w = [{ boot: "b", id: 1, instance: "w", sender: "w", role: "agent", text: "Hi.", ts: "2026-01-01T00:00:01Z" }];
  await current.mount(h(panel.ChatPanel, { route: { instance: "w" }, navKey: "one" }));
  const doc = current.document as any;
  const split = doc.querySelector(".chat-split"); if (split) split.clientWidth = 1200;
  return doc;
}
const settleAll = async () => { for (let i = 0; i < 8; i++) await settle(); };
const wait = async (ms = 120) => { await new Promise((r) => setTimeout(r, ms)); await settleAll(); };
async function openWs() { pp.openWorkspace({ key: "ws:w", instance: "w" }); await settleAll(); }
const followBtn = (doc: any) => doc.querySelector(".ws-panel .ws-follow");
const follows = () => calls.filter((u) => u.includes("op=follow")).length;
const hl = (doc: any, cls: string) => [...doc.querySelectorAll(`.ws-text .ws-line.${cls}`)].map((e: any) => Number(e.getAttribute("data-line")));

describe("Follow agent (#3160)", () => {
  it("off by default: the panel never asks for the agent's steps", async () => {
    serve();
    const doc = await chat();
    await openWs();
    await wait();
    expect(follows()).toBe(0);
    expect([followBtn(doc).textContent, followBtn(doc).getAttribute("aria-pressed")]).toEqual(["Follow agent", "false"]);
    expect(doc.querySelector(".ws-history")).toBeNull();
  });

  it("on: an edit opens the file with the changed lines highlighted; a read highlights its range; the strip lists the turn", async () => {
    serve();
    follow = [{ supported: true, running: true, turn: 1, steps: [step(1, "edit", [P("src/a.ts")])] }];
    const doc = await chat();
    await openWs();
    followBtn(doc).click(); await wait();
    expect(followBtn(doc).textContent).toBe("Following");
    expect(doc.querySelector(".ws-viewer-head .ws-path").textContent).toBe("src/a.ts");
    expect(hl(doc, "hl-edit")).toEqual([3]);
    expect(calls.some((u) => u.includes("op=diff&path=src%2Fa.ts"))).toBe(true);
    follow = [{ supported: true, running: true, turn: 1, steps: [step(2, "read", [P("src/a.ts")], { range: { from: 4, to: 5 } })] }];
    await wait();
    expect(hl(doc, "hl-read")).toEqual([4, 5]);
    const chips = [...doc.querySelectorAll(".ws-history .ws-step")] as any[];
    expect(chips.map((c) => c.textContent)).toEqual(["Edita.ts", "Reada.ts"]);
    expect(chips[1].getAttribute("aria-current")).toBe("true");
  });

  it("a search shows the folder with the entry marked; a hidden file is listed, never opened; a shell guess is marked ≈", async () => {
    serve();
    follow = [{ supported: true, running: true, turn: 1, steps: [step(1, "search", [P("src/b.ts")]), step(2, "read", [P(".env", { hidden: true })], { exact: false })] }];
    const doc = await chat();
    await openWs();
    followBtn(doc).click(); await wait();
    expect(calls.some((u) => u.includes("op=file&path=.env")), "a hidden file is never asked for").toBe(false);
    const chips = [...doc.querySelectorAll(".ws-history .ws-step")] as any[];
    expect(chips.map((c) => [c.textContent, c.disabled])).toEqual([["Searchb.ts", false], ["Read ≈.env", true]]);
    chips[0].click(); await settleAll();                                             // a click shows it (and pauses)
    expect(doc.querySelector(".ws-entry.hl .ws-name").textContent).toBe("b.ts");
  });

  it("what you do yourself pauses Follow: newer steps join the strip but are not shown, until Resume shows the newest", async () => {
    serve();
    follow = [{ supported: true, running: true, turn: 1, steps: [step(1, "edit", [P("src/a.ts")])] }];
    const doc = await chat();
    await openWs();
    followBtn(doc).click(); await wait();
    doc.querySelector(".ws-viewer-head button").click(); await settleAll();         // Back: your own move
    expect(followBtn(doc).textContent).toBe("Paused · Resume");
    follow = [{ supported: true, running: true, turn: 1, steps: [step(2, "read", [P("src/b.ts")])] }];
    await wait();
    expect(doc.querySelector(".ws-viewer-head")).toBeNull();                        // not pulled back
    expect(doc.querySelectorAll(".ws-history .ws-step").length).toBe(2);
    followBtn(doc).click(); await wait();
    expect([followBtn(doc).textContent, doc.querySelector(".ws-viewer-head .ws-path").textContent]).toEqual(["Following", "src/b.ts"]);
    fire(doc.querySelector(".ws-body"), "wheel");
    await settleAll();
    expect(followBtn(doc).textContent, "scrolling the file is your own move too").toBe("Paused · Resume");
  });

  it("follows the newest completion without duplicating or reordering concurrent calls, including Resume", async () => {
    serve();
    const frame = (a: number, b: number) => ({ supported: true, running: true, turn: 1, steps: [
      step(a, "read", [P("src/a.ts")], { id: "call-a", phase: "done" }),
      step(b, "read", [P("src/b.ts")], { id: "call-b", phase: "done" }),
    ] });
    follow = [frame(1, 2)];
    const doc = await chat(); await openWs(); followBtn(doc).click(); await wait();
    expect(doc.querySelector(".ws-viewer-head .ws-path").textContent).toBe("src/b.ts");
    follow = [frame(4, 3)]; await wait();
    expect(doc.querySelector(".ws-viewer-head .ws-path").textContent).toBe("src/a.ts");
    const chips = doc.querySelectorAll(".ws-history .ws-step");
    expect([...chips].map((c: any) => c.textContent)).toEqual(["Reada.ts", "Readb.ts"]);
    chips[1].click(); await settleAll();
    expect(doc.querySelector(".ws-viewer-head .ws-path").textContent).toBe("src/b.ts");
    followBtn(doc).click(); await wait();
    expect(doc.querySelector(".ws-viewer-head .ws-path").textContent).toBe("src/a.ts");
  });

  it("a new turn replaces the strip; closing the panel stops asking", async () => {
    serve();
    follow = [{ supported: true, running: true, turn: 1, steps: [step(1, "read", [P("src/a.ts")])] }, { supported: true, running: true, turn: 2, steps: [step(2, "read", [P("src/b.ts")])] }];
    const doc = await chat();
    await openWs();
    followBtn(doc).click(); await wait();
    expect([...doc.querySelectorAll(".ws-history .ws-step")].map((c: any) => c.textContent)).toEqual(["Readb.ts"]);
    pp.closePanel(); await settleAll();
    const n = follows();
    await wait();
    expect(follows()).toBe(n);
  });

  it("a late automatic read cannot replace the file after the user scrolls or turns Follow off", async () => {
    for (const action of ["scroll", "off"]) {
      serve();
      follow = [{ supported: true, running: true, turn: 1, steps: [step(1, "read", [P("src/a.ts")])] }];
      const doc = await chat(); await openWs(); followBtn(doc).click(); await wait();
      const original = globalThis.fetch;
      let release!: () => void, entered!: () => void;
      const started = new Promise<void>(r => { entered = r; });
      globalThis.fetch = (async (...args: any[]) => {
        const url = String(args[0]);
        if (url.includes("op=file&path=src%2Fb.ts")) { entered(); await new Promise<void>(r => { release = r; }); }
        return (original as any)(...args);
      }) as any;
      follow = [{ supported: true, running: true, turn: 1, steps: [step(2, "read", [P("src/b.ts")])] }];
      await started;
      if (action === "scroll") fire(doc.querySelector(".ws-body"), "wheel"); else followBtn(doc).click();
      await settleAll(); release(); await wait();
      expect(doc.querySelector(".ws-viewer-head .ws-path").textContent, action).toBe("src/a.ts");
      expect(followBtn(doc).getAttribute("aria-pressed"), action).toBe("false");
      pp.closePanel(); await current!.unmount(); current!.restore(); current = null;
    }
  });

  it("a replacement launch with repeated turn/cursor numbers replaces the strip", async () => {
    serve();
    follow = [{ supported: true, running: true, scope: "launch-a", turn: 1, steps: [step(1, "read", [P("src/a.ts")])] },
      { supported: true, running: true, scope: "launch-b", turn: 1, steps: [step(1, "read", [P("src/b.ts")])] }];
    const doc = await chat(); await openWs(); followBtn(doc).click(); await wait();
    expect([...doc.querySelectorAll(".ws-step")].map((e: any) => e.textContent)).toEqual(["Readb.ts"]);
    expect(doc.querySelector(".ws-viewer-head .ws-path").textContent).toBe("src/b.ts");
    expect(calls.some(u => u.includes("scope=launch-a"))).toBe(true);
  });

  it("does no polling while hidden and coalesces navigation while keeping the turn strip", async () => {
    serve();
    const doc = await chat(); await openWs();
    Object.defineProperty(doc, "hidden", { configurable: true, value: true });
    followBtn(doc).click(); await wait();
    expect(follows()).toBe(0);
    Object.defineProperty(doc, "hidden", { configurable: true, value: false });
    const previous = wsp.FOLLOW_TIMING.applyMs; wsp.FOLLOW_TIMING.applyMs = 100;
    try {
      follow = Array.from({ length: 6 }, (_, i) => ({ supported: true, running: true, turn: 1, steps: [step(i + 1, "read", [P(i % 2 ? "src/b.ts" : "src/a.ts")])] }));
      await wait(160);
      expect(doc.querySelectorAll(".ws-step").length).toBe(6);
      expect(calls.filter(u => u.includes("op=file")).length).toBeLessThanOrEqual(2);
    } finally { wsp.FOLLOW_TIMING.applyMs = previous; }
  });

  it("a backend Follow does not cover, or an agent that is not running, is said in words", async () => {
    serve({ supported: false, running: true, turn: 0, steps: [] });
    const doc = await chat();
    await openWs();
    followBtn(doc).click(); await wait();
    expect(doc.querySelector(".ws-follow-note").textContent).toBe("Follow works for Claude Code and Codex agents");
    i18n.setLang("zh-TW", { store: false }); await settleAll();
    expect(doc.querySelector(".ws-follow-note").textContent).toBe("跟隨只支援 Claude Code 與 Codex 的 Agent");
  });

  it("changedLines: the new file's added or changed lines; a pure removal marks where it was", () => {
    const patch = "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,3 +1,4 @@\n one\n-two\n+TWO\n three\n+four\n@@ -10,2 +11,1 @@\n ten\n-eleven\n";
    expect([...wsp.changedLines(patch)].sort((a: number, b: number) => a - b)).toEqual([2, 4, 12]);
  });
});
