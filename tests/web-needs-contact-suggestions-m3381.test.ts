/**
 * M-3381 (the user, beta.14): Needs you on the web listed every existing ClassicBot room's restricted-mode suggestion as
 * its own group — one row per room. Now they are ONE low-key group below the rest, closed until opened ("N existing
 * ClassicBot rooms can switch to restricted mode"), each room's card (switch / preview / later) inside, and counted once
 * (the page's count, the sidebar's and the tab's: needsCount). The real Needs you panel, en and zh-TW.
 */
import { afterEach, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";

const pages: AppPage[] = [];
afterEach(async () => { for (const p of pages.splice(0)) { await p.unmount(); p.restore(); } delete (globalThis as any).fetch; });
const suggestion = (room: string) => ({ id: `contact-suggest:${room}`, type: "contact", reason: "contact_restricted_suggestion", instance: room,
  since: Date.now() - 60_000, detail: "", contactSuggestion: { instance: room } });
const NEEDS = [suggestion("room-1"), suggestion("room-2"), suggestion("room-3"),
  { id: "crashed:worker:1", type: "instance", instance: "worker", reason: "crashed", detail: "", since: Date.now() - 120_000 }];

it.each([["en", "3 existing ClassicBot room(s) can switch to restricted mode", "2 waiting"],
  ["zh-TW", "3 個既有 ClassicBot 房間可以切換為受限模式", "2 件待處理"]])("%s: one closed group for the rooms' suggestions, below the rest, counted once", async (lang, head, count) => {
  const p = page({ url: "http://127.0.0.1:19280/ui/needs", storage: { agend_tour_done: "1" } }); pages.push(p);
  (globalThis as any).fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
  const app = await import("/assets/app-store.js" as string), i18n = await import("/assets/app-i18n.js" as string);
  const panel = await import("/ui/js/panel-needs.js" as string), shell = await import("/assets/app-shell.js" as string);
  const nav = await import("/assets/app-nav.js" as string); nav.startRouter(p.window);
  i18n.setLang(lang, { store: false });
  try {
    app.appStore.set({ ready: true, needsLoaded: true, proposals: [], needs: NEEDS, instances: [{ name: "worker" }, { name: "room-1" }, { name: "room-2" }, { name: "room-3" }] });
    await p.mount(h(panel.NeedsPanel, { route: { panel: "needs" }, navKey: `needs:|1|${lang}` })); await settle(6);
    const groups = [...p.root.querySelectorAll(".n-group")];
    expect(groups.map((g: any) => g.classList.contains("n-suggestions")), "the suggestions last, after the crashed worker").toEqual([false, true]);
    const box = p.root.querySelector("details.n-suggestions") as any;
    expect((box.querySelector("summary")?.textContent || "").trim()).toBe(head);
    expect(box.hasAttribute("open"), "low-key: closed until opened").toBe(false);
    expect(box.querySelectorAll(".contact-need").length, "each room's card inside").toBe(3);
    expect(box.querySelectorAll(".n-actions button").length, "switch and later per room").toBe(6);
    expect(p.root.textContent).toContain(count);
    expect(shell.needsCount({ needs: NEEDS, proposals: [] }), "the sidebar's and the tab's count").toBe(2);
  } finally { i18n.setLang("en", { store: false }); }
});
