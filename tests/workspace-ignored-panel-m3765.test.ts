/**
 * M-3765: the Files tab of the Files & changes panel (the real modules) — soul.md listed though git ignores it (marked
 * "ignored by git") and opened like any file; "Show files git ignores" asks the server for everything (ignored=1), marks
 * each ignored entry, keeps a secret-looking one hidden, and is off again for the next agent. In en and zh-TW.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installDom, settle } from "./helpers/mini-dom.js";
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

const CHANGES = { repo: true, branch: "main", hiddenCount: 1, cut: { files: false, bytes: false },
  files: [
    { path: "app.js", status: "modified", adds: 2, dels: 1, binary: false, hidden: false, untracked: false },
    { path: "notes.md", status: "untracked", adds: 1, dels: 0, binary: false, hidden: false, untracked: true },
    { path: ".env", status: "untracked", adds: null, dels: null, binary: false, hidden: true, untracked: true },
    { path: "logo.bin", status: "modified", adds: null, dels: null, binary: true, hidden: false, untracked: false },
    { path: "big.txt", status: "modified", adds: 900, dels: 0, binary: false, hidden: false, untracked: false, tooLarge: true },
  ],
  patch: "diff --git a/app.js b/app.js\nindex 1..2 100644\n--- a/app.js\n+++ b/app.js\n@@ -1,2 +1,3 @@\n-const a = 1;\n+const a = 2;\n console.log(a);\n+console.log('more');\n"
    + "diff --git a/notes.md b/notes.md\nnew file mode 100644\n--- /dev/null\n+++ b/notes.md\n@@ -0,0 +1 @@\n+# New\n" };
// What the server answers (agent-workspace.ts): by default soul.md (always listed, here ignored) and the tracked files;
// with ignored=1 also what git ignores, each marked, a secret-looking one still hidden.
const LIST = { path: "", cut: false, entries: [
  { name: "src", type: "dir", size: null, hidden: false }, { name: "app.js", type: "file", size: 40, hidden: false },
  { name: "soul.md", type: "file", size: 120, hidden: false, ignored: true }] };
const LIST_ALL = { path: "", cut: false, entries: [
  { name: "node_modules", type: "dir", size: null, hidden: false, ignored: true }, { name: "src", type: "dir", size: null, hidden: false },
  { name: ".env", type: "file", size: 20, hidden: true, ignored: true }, { name: "app.js", type: "file", size: 40, hidden: false },
  { name: "debug.log", type: "file", size: 10, hidden: false, ignored: true }, { name: "soul.md", type: "file", size: 120, hidden: false, ignored: true }] };
let calls: string[] = [];
function serve(over: Record<string, [number, unknown]> = {}) {
  calls = [];
  globalThis.fetch = vi.fn(async (url: string) => {
    calls.push(url);
    const q = new URL(url, "http://x").searchParams, key = `${q.get("op")}:${q.get("path") ?? ""}`;
    const [status, body] = over[key] ?? (q.get("op") === "changes" ? [200, CHANGES] : q.get("op") === "list" ? [200, q.get("ignored") === "1" ? LIST_ALL : LIST]
      : key === "file:app.js" ? [200, { kind: "text", path: "app.js", size: 40, text: "const a = 2;\nconsole.log(a);\n" }]
      : key === "file:soul.md" ? [200, { kind: "text", path: "soul.md", size: 120, text: "# Example agent's memory\n" }]
      : key === "file:logo.png" ? [200, { kind: "image", path: "logo.png", size: 12, mime: "image/png" }]
      : [404, { error: "not_found" }]);
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
async function openWs() { pp.openWorkspace({ key: "ws:w", instance: "w" }); await settleAll(); }
const tabBtn = (doc: any, i: number) => doc.querySelectorAll(".ws-panel .seg-inline button")[i];

describe("Files: what git ignores (M-3765)", () => {
  it("soul.md is listed (marked ignored by git) and opens; the toggle lists everything, each ignored entry marked", async () => {
    serve();
    const doc = await chat();
    await openWs();
    tabBtn(doc, 1).click(); await settleAll();
    const row = (n: string) => ([...doc.querySelectorAll(".ws-entry")] as any[]).find((e) => e.querySelector(".ws-name").textContent.replace(/\/$/, "") === n);
    expect(row("soul.md").className).toContain("is-ignored");
    expect(row("soul.md").querySelector(".ws-meta").textContent).toBe("120 B · ignored by git");
    expect(row("app.js").className).not.toContain("is-ignored");
    expect(row("node_modules")).toBeUndefined();
    const toggle = doc.querySelector(".ws-ignored-toggle input");
    expect(doc.querySelector(".ws-ignored-toggle").textContent).toBe("Show files git ignores");
    expect(toggle.checked).toBe(false);
    expect(calls.filter((u) => u.includes("op=list")).every((u) => !u.includes("ignored="))).toBe(true);
    toggle.checked = true; toggle.dispatchEvent(new (globalThis as any).Event("change", { bubbles: true })); await settleAll();
    expect(calls.filter((u) => u.includes("op=list")).at(-1)).toBe("/ui/workspace?instance=w&op=list&path=&ignored=1");
    expect(row("node_modules").className).toContain("is-ignored");
    expect(row("debug.log").querySelector(".ws-meta").textContent).toBe("10 B · ignored by git");
    expect(row(".env").querySelector("button").disabled).toBe(true);            // still hidden: listed, never opened
    expect(row(".env").querySelector(".ws-meta").textContent).toBe("hidden: may contain secrets · ignored by git");
    // Opening a folder keeps asking for everything while the toggle is on.
    row("node_modules").querySelector("button").click(); await settleAll();
    expect(calls.filter((u) => u.includes("op=list")).at(-1)).toBe("/ui/workspace?instance=w&op=list&path=node_modules&ignored=1");
  });
  it("soul.md opens like any other file", async () => {
    serve();
    const doc = await chat();
    await openWs();
    tabBtn(doc, 1).click(); await settleAll();
    ([...doc.querySelectorAll(".ws-entry")] as any[]).find((e) => e.querySelector(".ws-name").textContent === "soul.md").querySelector("button").click(); await settleAll();
    expect(doc.querySelector(".ws-text code").textContent).toContain("Example agent's memory");
  });
  it("zh-TW: the toggle and the mark in Chinese", async () => {
    i18n.setLang("zh-TW", { store: false });
    serve();
    const doc = await chat();
    await openWs();
    tabBtn(doc, 1).click(); await settleAll();
    expect(doc.querySelector(".ws-ignored-toggle").textContent).toBe("顯示 git 忽略的檔案");
    const soul = ([...doc.querySelectorAll(".ws-entry")] as any[]).find((e) => e.querySelector(".ws-name").textContent === "soul.md");
    expect(soul.querySelector(".ws-meta").textContent).toBe("120 B · git 已忽略");
  });
  it("its words come from a module of their own (an older cached workspace-strings.js lacks them)", async () => {
    const { readFileSync } = await import("node:fs");
    expect(readFileSync("src/ui/workspace-panel.js", "utf8")).toContain('import "./workspace-ignored-strings.js";');
    expect(readFileSync("src/ui/workspace-strings.js", "utf8")).not.toContain("wsShowIgnored");
  });
});
