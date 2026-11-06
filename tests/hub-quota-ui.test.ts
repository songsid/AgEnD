import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

let quota: any, client: any, words: any;
let pg: AppPage | null = null;
beforeAll(async () => {
  const p = page();
  quota = await import("/ui/js/hub-quota.js");
  client = await import("/ui/js/hub-client.js");
  words = await import("/assets/app-i18n.js");
  p.restore();
});
afterEach(async () => { if (pg) { await pg.unmount(); pg.restore(); pg = null; } client.setHubClient(null); words.setLang("en", { store: false }); });
async function mount(room: unknown) {
  pg ??= page();
  await pg.mount(h("div", null, h(quota.QuotaCard, { room }), h(quota.QuotaChip, { room }), h(quota.QuotaBanner, { room })));
  return pg.root;
}
describe("the lazy quota module for B and C", () => {
  it.each(["en", "zh-TW"])("renders all bands, chip/banner conditions and no percentages in %s", async language => {
    words.setLang(language, { store: false });
    for (const [band, text] of language === "en" ? [["available", "Available"], ["near_limit", "Near limit"], ["exhausted", "Exhausted"], ["unknown", "Unknown"]]
      : [["available", "充足"], ["near_limit", "快用完"], ["exhausted", "用完"], ["unknown", "未知"]]) {
      const root = await mount({ quota: { band } });
      expect(root.querySelector(".hub-quota-card").textContent).toContain(text);
      expect(!!root.querySelector(".hub-quota-chip")).toBe(band !== "available");
      expect(!!root.querySelector(".hub-quota-banner")).toBe(band === "exhausted");
      expect(root.textContent).not.toContain("%");
    }
  });
  it("omits every element for hidden, absent or unrecognised quota data", async () => {
    for (const room of [{}, null, { quota: null }, { quota: { band: "private-account-label" } }]) {
      const root = await mount(room); expect(root.textContent).toBe(""); expect(root.querySelector("section")).toBeNull();
    }
  });
  it("formats only the coarse five-minute time in the browser's timezone", async () => {
    words.setLang("zh-TW", { store: false });
    const at = Date.parse("2026-11-06T12:15:00Z"), d = new Date(at);
    const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    const root = await mount({ quota: { band: "exhausted", resetsAt: at } });
    expect(root.querySelector(".hub-quota-chip").textContent).toBe(`用完，約 ${time} 恢復`);
    expect(root.querySelector(".hub-quota-banner").textContent).toContain("問題會排隊等候");
    expect(quota.quotaLabel({ band: "exhausted", resetsAt: at + 1 })).toBe("用完");
  });
  it("saves visibility with the exposure revision and reports conflicts without changing the switch", async () => {
    pg = page();
    const save = vi.fn().mockResolvedValueOnce({ ok: false, code: "conflict" }).mockResolvedValueOnce({ ok: true, quotaVisible: false });
    client.setHubClient({ quotaVisibility: save });
    const onSaved = vi.fn();
    await pg.mount(h(quota.QuotaVisibilityRow, { exposure: { id: "agent-id", revision: 3, quotaVisible: true }, onSaved }));
    let box = pg.root.querySelector('input[role="switch"]'); box.checked = false; fire(box, "change"); await settle(8);
    expect(save).toHaveBeenCalledWith("agent-id", 3, false);
    expect(pg.root.querySelector('[role="alert"]').textContent).toContain("Reload"); expect(onSaved).not.toHaveBeenCalled();
    expect(pg.root.querySelector('input[role="switch"]').checked).toBe(true);
    box = pg.root.querySelector('input[role="switch"]'); box.checked = false; fire(box, "change"); await settle(8);
    expect(onSaved).toHaveBeenCalledWith({ ok: true, quotaVisible: false });
    expect(pg.root.querySelector('input[role="switch"]').checked).toBe(false);
  });
  it("an older retained Hub client without the setter shows a failure safely", async () => {
    pg = page(); client.setHubClient({});
    await pg.mount(h(quota.QuotaVisibilityRow, { exposure: { id: "agent-id", revision: 1, quotaVisible: true } }));
    const box = pg.root.querySelector("input"); box.checked = false; fire(box, "change"); await settle(8);
    expect(pg.root.querySelector('[role="alert"]').textContent).toContain("Could not save");
  });
});
