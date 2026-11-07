import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

const search = vi.hoisted(() => {
  let resolve!: (m: unknown) => void;
  const pending = new Promise(r => { resolve = r; });
  return { pending, resolve };
});
vi.mock("/ui/js/search-dialog.js", () => search.pending);
let p: AppPage | undefined;
afterEach(async () => { if (p) { await p.unmount(); p.restore(); p = undefined; } vi.unstubAllGlobals(); });

describe("#3290 shared loading states", () => {
  it("draws content-shaped rows, labels the wait, hides decorative bars and loads its CSS once", async () => {
    p = page();
    const { Skeleton } = await import("/assets/ui-states.js");
    await p.mount(h(Skeleton, { variant: "rows", lines: 3, label: "Reading accounts…" }));
    expect(p.document.querySelectorAll(".sk-thumb")).toHaveLength(3);
    expect(p.document.querySelectorAll(".sk-pill")).toHaveLength(3);
    expect(p.document.querySelector(".skeleton")?.getAttribute("aria-label")).toBe("Reading accounts…");
    expect(p.document.querySelector('.skeleton [aria-hidden="true"]')).not.toBeNull();
    await p.mount(h(Skeleton, { lines: 4 }));
    expect(p.document.querySelectorAll(".sk-line")).toHaveLength(4);
    expect(p.document.querySelectorAll('link[href="/assets/loading.css"]')).toHaveLength(1);
  });

  it("ships visible boot and sign-in shapes before JavaScript, with a reduced-motion rule", () => {
    const app = readFileSync("src/ui/app.html", "utf8"), signin = readFileSync("src/ui/signin.html", "utf8");
    const css = readFileSync("src/ui/shared/loading.css", "utf8");
    expect(app).toContain('class="sk-boot"');
    expect(app).toContain('class="sk-line sk-thumb"');
    expect(signin).toContain('id="checking" class="skeleton sk-signin"');
    for (const markup of [app, signin]) expect(markup).toContain('href="/assets/loading.css"');
    expect(css).toMatch(/prefers-reduced-motion: reduce[^}]+animation: none; opacity: 1/s);
  });

  it("never presents unknown Needs or Notices as a completed empty result, and ends a failed Notice read", async () => {
    p = page();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) })));
    const { appStore, mergeNoticeList } = await import("/assets/app-store.js");
    const { NeedsPanel } = await import("/ui/js/panel-needs.js");
    const { NoticesPanel } = await import("/ui/js/panel-notices.js");
    appStore.set({ ready: false, needsLoaded: false, needs: [], instances: [], connections: 0, notices: null, noticesError: false, readNotices: () => {} });
    await p.mount(h(NeedsPanel, { navKey: "pending" }));
    expect(p.document.querySelector(".p-needs .skeleton")).not.toBeNull();
    expect(p.document.querySelector(".p-needs .empty")).toBeNull();
    appStore.set({ ready: true }); await settle();
    expect(p.document.querySelector(".p-needs .empty")).toBeNull();
    appStore.set({ needsLoaded: true }); await settle();
    expect(p.document.querySelector(".p-needs .empty")).not.toBeNull();
    // An older app.js never names this optional flag; its known status remains the fallback.
    appStore.set({ needsLoaded: undefined }); await settle();
    expect(p.document.querySelector(".p-needs .empty")).not.toBeNull();
    await p.mount(h(NoticesPanel, { navKey: "notices" }));
    expect(p.document.querySelector(".p-notices .skeleton")).not.toBeNull();
    appStore.set({ noticesError: true }); await settle();
    expect(p.document.querySelector(".p-notices .skeleton")).toBeNull();
    expect(p.document.querySelector(".p-notices .error-state")).not.toBeNull();
    appStore.set({ notices: mergeNoticeList(null, { enabled: true, items: [], seen: 0 }), noticesError: false }); await settle();
    expect(p.document.querySelector(".p-notices .empty")).not.toBeNull();
  });

  it("records a first Notice read failure and clears it when Retry succeeds", async () => {
    p = page();
    const { createStore, createNoticesSync } = await import("/assets/app-store.js");
    const store = createStore({ notices: null });
    let failed = true;
    const sync = createNoticesSync({ store, fetchList: async () => { if (failed) throw new Error("offline"); return { enabled: true, items: [], seen: 0 }; } });
    await sync.read();
    expect(store.get().noticesError).toBe(true);
    failed = false; await sync.read();
    expect(store.get().noticesError).toBe(false);
    expect(store.get().notices?.items).toEqual([]);
  });

  it("shows and allows cancelling the first search import; its late result cannot reopen the dialog", async () => {
    p = page();
    const shell = await import("/assets/app-shell.js");
    const { useStore } = await import("/assets/app-store.js");
    function Host() { const { dialog } = useStore(shell.shellStore); return dialog ? h(dialog.Component, dialog.props) : null; }
    await p.mount(h(Host, {}));
    shell.openSearch(); await settle();
    expect(p.document.querySelector("dialog .skeleton")).not.toBeNull();
    fire(p.document.querySelector(".dlg-x")!, "click"); await settle();
    expect(shell.shellStore.get().dialog).toBeNull();
    search.resolve({ SearchDialog: () => h("div", { id: "resolved-search" }) }); await settle();
    expect(p.document.querySelector("#resolved-search")).toBeNull();
    shell.openSearch(); await settle();
    expect(p.document.querySelector("#resolved-search")).not.toBeNull();
    shell.closeDialog();
  });
});
