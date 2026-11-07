import { afterEach, describe, expect, it, vi } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
let p: AppPage | undefined;
afterEach(async () => { if (p) { await p.unmount(); p.restore(); p = undefined; } vi.unstubAllGlobals(); });
const response = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
function held() { let release!: (body: unknown) => void; const promise = new Promise(r => { release = body => r(response(body)); }); return { promise, release }; }

describe("#3290 alpha initial data", () => {
  it("keeps the Accounts heading during the first read and retains populated content during refresh", async () => {
    p = page(); const first = held(), refresh = held(); let reads = 0;
    vi.stubGlobal("fetch", vi.fn((url: string) => url === "/ui/accounts" ? (++reads === 1 ? first.promise : refresh.promise) : Promise.resolve(response({}))));
    const A = await import("/ui/js/accounts-view.js");
    A.accountsStore.set({ loaded: false, failed: false, view: null });
    await p.mount(h(A.AccountsView, { instances: {}, stageAgent() {}, stageDefault() {} }));
    expect(p.document.querySelector(".s-accounts h3")).not.toBeNull();
    expect(p.document.querySelector(".s-accounts .skeleton")).not.toBeNull();
    first.release({ clis: [] }); await settle();
    expect(p.document.querySelector(".s-accounts .skeleton")).toBeNull();
    void A.refreshAccounts(); await settle();
    expect(p.document.querySelector(".s-accounts h3")).not.toBeNull();
    expect(p.document.querySelector(".s-accounts .skeleton")).toBeNull();
    refresh.release({ clis: [] }); await settle();
  });

  it("does not call unknown machine inventory zero or draw unchecked policy switches", async () => {
    p = page(); const inventory = held(), policy = held();
    vi.stubGlobal("fetch", vi.fn((url: string) => url === "/ui/runtimes" ? inventory.promise : url === "/api/settings/runtimes" ? policy.promise : Promise.resolve(response({}))));
    const catalog = await import("/ui/js/runtime-catalog.js"); catalog.forgetRuntimeCatalog();
    const { appStore } = await import("/assets/app-store.js"); appStore.set({ windowsCli: false });
    const { RuntimesPanel } = await import("/ui/js/panel-runtimes.js");
    await p.mount(h(RuntimesPanel, { navKey: "pending-runtime" }));
    expect(p.document.querySelector(".runtime-machines .skeleton")).not.toBeNull();
    expect(p.document.querySelector(".runtime-switches .skeleton")).not.toBeNull();
    expect(p.document.querySelectorAll('.runtime-switches input[role="switch"]')).toHaveLength(0);
    expect(p.document.querySelector(".runtime-computers-heading")?.textContent).not.toContain("0 computers");
    inventory.release({ enabled: true, machines: [] });
    policy.release({ switches: { windows_cli: { on: false }, remote_runtime: { on: true } }, max_agents_per_machine: { value: 4, min: 1, max: 16, default: 4 } });
    await settle(8);
    expect(p.document.querySelector(".runtime-machines .skeleton")).toBeNull();
    expect(p.document.querySelector(".runtime-switches .skeleton")).toBeNull();
    expect(p.document.querySelectorAll('.runtime-switches input[role="switch"]').length).toBeGreaterThan(0);
    await p.unmount(); catalog.forgetRuntimeCatalog();
  });

  it("shows row skeletons for Changes and directory reads, and text bars for a file read", async () => {
    p = page(); const changes = held(), listing = held(), file = held();
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      const op = new URL(url, "http://fixture").searchParams.get("op");
      return op === "changes" ? changes.promise : op === "list" ? listing.promise : op === "file" ? file.promise : Promise.resolve(response({}));
    }));
    const { WorkspacePanel } = await import("/ui/js/workspace-panel.js");
    await p.mount(h(WorkspacePanel, { open: { instance: "w" }, name: "w", panel: { current: null }, fs: false, enterFs() {}, leaveFs() {}, onKey() {}, subscribe: () => () => {}, close() {} }));
    expect(p.document.querySelector(".ws-panel .sk-row")).not.toBeNull();
    changes.release({ repo: true, branch: "main", files: [], patch: "" }); await settle();
    const tabs = p.document.querySelectorAll(".ws-panel .seg-inline button"); fire(tabs[1]!, "click"); await settle();
    expect(p.document.querySelector(".ws-panel .sk-row")).not.toBeNull();
    listing.release({ path: "", cut: false, entries: [{ name: "app.js", type: "file", size: 20 }] }); await settle();
    fire(p.document.querySelector(".ws-entry button")!, "click"); await settle();
    expect(p.document.querySelector(".ws-viewer-head")).not.toBeNull();
    expect(p.document.querySelector(".ws-panel .skeleton")).not.toBeNull();
    expect(p.document.querySelector(".ws-panel .sk-row")).toBeNull();
    file.release({ kind: "text", text: "export const x = 1;\n", path: "app.js" }); await settle();
    expect(p.document.querySelector(".ws-panel .skeleton")).toBeNull();
  });
});
