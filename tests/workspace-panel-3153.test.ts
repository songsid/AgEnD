/**
 * #3153 P1: the Files & changes side panel in the chat (the real modules: panel-chat.js mounting the thread and the
 * panel, workspace-panel.js), over a faked /ui/workspace: Changes by default — the file list with status, counts and
 * the reason a diff is not shown (hidden, binary, too large), a file's diff on a click; Files — the tree, a text file
 * with line numbers, an image by its own URL, why other files are not shown; "not offered" said in words; read again
 * when the agent replies; the menu entry absent over the public link and for an agent on another machine.
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
const LIST = { path: "", cut: false, entries: [
  { name: "src", type: "dir", size: null, hidden: false }, { name: ".env", type: "file", size: 20, hidden: true },
  { name: "app.js", type: "file", size: 40, hidden: false }, { name: "escape.txt", type: "symlink", size: null, hidden: false }, { name: "logo.png", type: "file", size: 12, hidden: false }] };
let calls: string[] = [];
function serve(over: Record<string, [number, unknown]> = {}) {
  calls = [];
  globalThis.fetch = vi.fn(async (url: string) => {
    calls.push(url);
    const q = new URL(url, "http://x").searchParams, key = `${q.get("op")}:${q.get("path") ?? ""}`;
    const [status, body] = over[key] ?? (q.get("op") === "changes" ? [200, CHANGES] : q.get("op") === "list" ? [200, LIST]
      : key === "file:app.js" ? [200, { kind: "text", path: "app.js", size: 40, text: "const a = 2;\nconsole.log(a);\n" }]
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

describe("Files & changes (#3153 P1)", () => {
  it("opens on Changes: each file with its status and counts, why a diff is not shown, a diff on a click", async () => {
    serve();
    const doc = await chat();
    await openWs();
    const p = doc.querySelector(".ws-panel");
    expect(p).not.toBeNull();
    expect(tabBtn(doc, 0).getAttribute("aria-selected")).toBe("true");
    expect(p.querySelector(".ws-summary").textContent).toBe("5 changed files on main · 1 hidden");
    expect(p.querySelector(".ws-readonly").textContent).toContain("Read-only");
    const rows = [...p.querySelectorAll(".ws-change")] as any[];
    expect(rows.map((r) => r.querySelector(".ws-path").textContent)).toEqual(["app.js", "notes.md", ".env", "logo.bin", "big.txt"]);
    expect(rows.map((r) => r.querySelector(".ws-why")?.textContent ?? null)).toEqual([null, null, "hidden: may contain secrets", "binary", "too large to show"]);
    expect(rows[2].querySelector(".ws-change-head").disabled).toBe(true);        // no diff for a hidden file
    rows[0].querySelector(".ws-change-head").click(); await settleAll();
    const diff = rows[0].querySelector(".ws-diff");
    expect([...diff.querySelectorAll(".d-add")].map((s: any) => s.textContent)).toEqual(["+ const a = 2;\n", "+ console.log('more');\n"]);
    expect([...diff.querySelectorAll(".d-del")].map((s: any) => s.textContent)).toEqual(["- const a = 1;\n"]);
    expect(p.querySelector("iframe")).toBeNull();
  });

  it("Files: the tree (hidden and links not openable), a text file with line numbers, an image by its own URL", async () => {
    serve();
    const doc = await chat();
    await openWs();
    tabBtn(doc, 1).click(); await settleAll();
    const entries = [...doc.querySelectorAll(".ws-entry")] as any[];
    expect(entries.map((e) => [e.querySelector(".ws-name").textContent, e.querySelector("button").disabled])).toEqual(
      [["src/", false], [".env", true], ["app.js", false], ["escape.txt", true], ["logo.png", false]]);
    entries[2].querySelector("button").click(); await settleAll();
    const code = doc.querySelector(".ws-text code");
    expect([...code.querySelectorAll(".ws-ln")].map((s: any) => s.textContent)).toEqual(["1", "2"]);
    expect(code.textContent).toContain("console.log(a);");
    doc.querySelector(".ws-viewer-head button").click(); await settleAll();
    ([...doc.querySelectorAll(".ws-entry")] as any[])[4].querySelector("button").click(); await settleAll();
    expect(doc.querySelector(".ws-image").getAttribute("src")).toBe("/ui/workspace?instance=w&op=image&path=logo.png");
    expect(calls.every((u) => u.startsWith("/ui/workspace?instance=w&op="))).toBe(true);
  });

  it("not offered (General, a coordinator): said in words; Refresh reads again", async () => {
    serve({ "changes:": [404, { error: "workspace_not_offered" }] });
    const doc = await chat();
    await openWs();
    expect(doc.querySelector(".ws-panel .pv-note[role=alert]").textContent).toContain("not available for this agent");
    const before = calls.length;
    doc.querySelector(".ws-refresh").click(); await settleAll();
    expect(calls.length).toBe(before + 1);
  });

  it("the agent's reply (the end of its turn) reads Changes again", async () => {
    serve();
    const doc = await chat();
    await openWs();
    const before = calls.filter((u) => u.includes("op=changes")).length;
    panel.store.ingest({ boot: "b", id: 2, instance: "w", sender: "w", role: "agent", text: "Done.", ts: "2026-01-01T00:00:02Z" });
    await new Promise((r) => setTimeout(r, 1700)); await settleAll();
    expect(calls.filter((u) => u.includes("op=changes")).length).toBeGreaterThan(before);
    void doc;
  });

  it("the patch is split per file into lines (headers dropped), as text", () => {
    const s = wsp.sectionsOf(CHANGES.patch);
    expect([...s.keys()]).toEqual(["app.js", "notes.md"]);
    expect(s.get("notes.md")).toEqual([{ t: "@", text: "@@ -0,0 +1 @@" }, { t: "+", text: "# New" }]);
  });

  it("zh-TW", async () => {
    serve();
    i18n.setLang("zh-TW", { store: false });
    const doc = await chat();
    await openWs();
    expect([...doc.querySelectorAll(".ws-panel .seg-inline button")].map((b: any) => b.textContent)).toEqual(["變更", "檔案"]);
    expect(doc.querySelector(".ws-summary").textContent).toBe("5 個檔案有變更（main） · 1 個已隱藏");
  });
});
