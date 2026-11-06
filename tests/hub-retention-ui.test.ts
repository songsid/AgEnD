import { afterEach, describe, expect, it } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

const mounted: AppPage[] = [];
afterEach(async () => { for (const pg of mounted.splice(0)) { await pg.unmount(); pg.restore(); } });
const until = async (test: () => unknown) => { for (let i = 0; i < 120 && !test(); i++) await settle(3); };
async function fixture(language: string, conflict = false) {
  const pg = page({ url: "http://127.0.0.1:19280/settings/access", storage: { agend_tour_done: "1" } }); mounted.push(pg);
  const calls: Array<{ path: string; options: any }> = [];
  (globalThis as any).fetch = async (path: string, options: any = {}) => {
    calls.push({ path, options });
    return { ok: !conflict || !options.method, status: conflict && options.method ? 409 : 200,
      json: async () => conflict && options.method ? { error: "conflict" } : { policy: { contentDays: 7, eventDays: 30, revision: options.method ? 4 : 3 } } };
  };
  // Retain the actual pre-existing Settings copy before the new lazy card registers its own namespace.
  await import("/ui/js/settings-strings.js");
  const i18n = await import("/assets/app-i18n.js"); i18n.setLang(language, { store: false });
  const module = await import("/ui/js/settings-hub-retention.js");
  await pg.mount(h(module.HubRetentionSettings, {})); await until(() => pg.root.querySelector("input"));
  return { pg, calls, inputs: Array.from(pg.root.querySelectorAll("input")) as any[] };
}
describe("the lazy host retention card", () => {
  it.each(["en", "zh-TW"])("renders localized copy with retained Settings strings in %s and submits the exact displayed revision", async language => {
    const { pg, calls, inputs } = await fixture(language);
    expect(pg.root.textContent).toContain(language === "en" ? "Hub record retention" : "Hub 紀錄保留期間");
    expect(pg.root.textContent).not.toContain("hubRetention.");
    expect(inputs.map(input => input.value)).toEqual(["7", "30"]);
    inputs[0].value = "12"; fire(inputs[0], "input"); await settle();
    fire(pg.root.querySelector("form")!, "submit"); await until(() => calls.length === 2);
    expect(JSON.parse(calls[1]!.options.body)).toEqual({ contentDays: 12, eventDays: 30, revision: 3 });
    expect(calls[1]!.options.method).toBe("PUT");
    await until(() => pg.root.textContent.includes(language === "en" ? "Retention saved." : "已儲存保留期間。"));
    expect(pg.root.textContent).toContain(language === "en" ? "Retention saved." : "已儲存保留期間。");
  });
  it("refuses invalid values locally and explains stale-save refusal without displaying raw error keys", async () => {
    const { pg, calls, inputs } = await fixture("en", true);
    inputs[0].value = "0"; fire(inputs[0], "input"); await settle();
    expect((pg.root.querySelector("button") as any).disabled).toBe(true);
    fire(pg.root.querySelector("form")!, "submit"); await settle(); expect(calls).toHaveLength(1);
    inputs[0].value = "9"; fire(inputs[0], "input"); await settle();
    fire(pg.root.querySelector("form")!, "submit"); await until(() => pg.root.textContent.includes("Reload before saving"));
    expect(pg.root.textContent).toContain("Reload before saving"); expect(pg.root.textContent).not.toContain("hubRetention.");
  });
});
