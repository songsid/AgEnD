import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
const io = vi.hoisted(() => ({ enabled: true, unknown: false, read: vi.fn(), write: vi.fn() }));
vi.mock("../src/ui/settings-confirm.js", () => ({
  api: async (...args: unknown[]) => { io.read(...args); return { ok: true, body: { enabled: io.enabled } }; },
  confirmedWrite: async (...args: unknown[]) => { io.write(...args); if (io.unknown) return { ok: false }; io.enabled = (args[1] as { body: { enabled: boolean } }).body.enabled; return { ok: true }; },
}));
let settings: any, notices: any, words: any, updates: any, store: any;
const pages: AppPage[] = [];
beforeAll(async () => {
  const p = page();
  settings = await import("/ui/js/settings-hub-page-sharing.js"); notices = await import("/ui/js/notice-hub-sharing.js");
  words = await import("/assets/app-i18n.js"); updates = await import("/assets/app-update.js"); store = await import("/assets/app-store.js"); p.restore();
});
afterEach(async () => { for (const p of pages.splice(0)) { await p.unmount(); p.restore(); } io.enabled = true; io.unknown = false; io.read.mockClear(); io.write.mockClear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function mount(component: any, props: unknown = {}, lang = "en") {
  const p = page({ storage: { agend_lang: lang } }); pages.push(p); words.setLang(lang);
  await p.mount(h(component, props)); await settle(12); return p;
}
it("draws the default-on switch with the approved scope, and writes through the existing Settings confirmation path", async () => {
  const p = await mount(settings.HubPageSharingSettings), box = p.root.querySelector("#hubShareFromHub") as any;
  expect([box.checked, box.disabled]).toEqual([true, false]);
  expect(p.root.textContent).toContain("only you can see"); expect(p.root.textContent).toContain("A notice with Undo");
  box.checked = false; fire(box, "change"); await settle(12);
  expect(io.write).toHaveBeenCalledWith("/api/settings/hub/share-from-hub", expect.objectContaining({ method: "PUT", body: { enabled: false } }));
  expect(box.checked).toBe(false); expect(io.read).toHaveBeenCalledTimes(2);
});
it("an uncertain save disables the choice until an explicit read; it does not silently send the write twice", async () => {
  const p = await mount(settings.HubPageSharingSettings), box = p.root.querySelector("#hubShareFromHub") as any;
  io.unknown = true; box.checked = false; fire(box, "change"); await settle(12);
  expect(box.disabled).toBe(true); expect(p.root.textContent).toContain("not confirmed");
  fire(p.root.querySelector("button"), "click"); await settle(12);
  expect(box.checked).toBe(true); expect(box.disabled).toBe(false); expect(io.write).toHaveBeenCalledTimes(1);
});
it("uses the same approved switch and explanation in zh-TW", async () => {
  const p = await mount(settings.HubPageSharingSettings, {}, "zh-TW");
  expect(p.root.textContent).toContain("允許我從 Hub 頁面分享 Agent"); expect(p.root.textContent).toContain("預設開啟"); expect(p.root.textContent).toContain("只有你看得到");
});
const at = 1_800_000_000_000;
const value = () => ({ key: "a".repeat(64), byName: "Owner", hubName: "Demo Hub", at, undoUntil: at + 86_400_000, version: 2, state: "complete",
  rows: [{ name: "Documents", kind: "classic-room", action: "share", state: "shared" }] });
it("offers Undo only to a Fleet admin, keeps Classic disclosure, and renders names as text", async () => {
  vi.spyOn(Date, "now").mockReturnValue(at);
  updates.updateStore.set({ info: { admin: false } });
  const p = await mount(notices.HubSharingNotice, { notice: { hubSharing: { ...value(), byName: "<img src=x>" } } });
  expect(p.root.querySelector("button")).toBeNull(); expect(p.root.querySelector("img")).toBeNull();
  expect(p.root.textContent).toContain("<img src=x>"); expect(p.root.textContent).toContain("one agent with one memory");
  updates.updateStore.set({ info: { admin: true } }); await settle(8);
  expect(p.root.querySelector("button")?.textContent).toBe("Undo");
  const undone = { ...value(), state: "undone", version: 103, rows: [{ ...value().rows[0], state: "undone" }] };
  const fetch = vi.fn(async () => ({ status: 200, json: async () => undone })); vi.stubGlobal("fetch", fetch);
  fire(p.root.querySelector("button"), "click"); await settle(12);
  expect(fetch).toHaveBeenCalledWith(`/api/settings/hub/sharing-notices/${value().key}/undo`, expect.objectContaining({ method: "POST", body: "{}" }));
  expect(p.root.textContent).toContain("no longer shared"); expect(p.root.querySelector("button")).toBeNull();
});
it("does not offer an expired Undo and localizes the notice in zh-TW", async () => {
  vi.spyOn(Date, "now").mockReturnValue(at + 86_400_000); updates.updateStore.set({ info: { admin: true } });
  const p = await mount(notices.HubSharingNotice, { notice: { hubSharing: value() } }, "zh-TW");
  expect(p.root.textContent).toContain("沒有人可以問"); expect(p.root.textContent).toContain("已經無法在這裡復原"); expect(p.root.querySelector("button")).toBeNull();
});
it("updates the same notice id on SSE and ignores older stages, while ordinary duplicate notices stay unchanged", () => {
  vi.spyOn(Date, "now").mockReturnValue(at);
  const first = { id: 1, at, text: "Pending", hubSharing: { ...value(), version: 1, state: "pending" } };
  const current = { enabled: true, seen: 0, unread: 1, items: [first] }, next = { ...first, text: "Shared", hubSharing: value() };
  const updated = store.addNotice(current, next);
  expect(updated.items).toEqual([next]); expect(store.addNotice(updated, first)).toBe(updated);
  expect(store.addNotice({ ...current, items: [{ id: 1, text: "Routine" }] }, { id: 1, text: "Other" }).items[0].text).toBe("Routine");
});
