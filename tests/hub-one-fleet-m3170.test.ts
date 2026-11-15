/**
 * M-3170 (found in M-3149): with one qualifying Fleet, Connected fleets offered "Update 1 Fleets that allow it". Every
 * sentence that counts Fleets has its one-Fleet form in English; zh-TW's sentence is the same for every count.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";

let v: any, words: any; const pages: AppPage[] = [];
beforeAll(async () => { const p = page(); v = await import("/ui/js/hub-fleet-versions.js"); words = await import("/assets/app-i18n.js"); p.restore(); });
afterEach(async () => { for (const p of pages.splice(0)) { await p.unmount(); p.restore(); } vi.restoreAllMocks(); });
const row = (over: Record<string, unknown> = {}) => ({ id: "f1", status: "active", label: "design-pc", owner: { name: "Ada" }, version: "2.4.0-beta.1",
  connected: true, versionState: "needs-update", updatesAllowed: true, updateRequest: null, ...over });

describe("one Fleet, said as one", () => {
  it("the button: Update 1 Fleet that allows it (2: Fleets that allow it)", async () => {
    const one = page({ storage: { agend_lang: "en" } }); pages.push(one); words.setLang("en");
    await one.mount(h("div", {}, h(v.UpdateAllowedButton, { fleets: [row()], recommended: "2.4.0", revision: 1, client: {} }),
      h(v.UpdateAllowedButton, { fleets: [row(), row({ id: "f2" })], recommended: "2.4.0", revision: 1, client: {} }))); await settle(4);
    expect([...one.root.querySelectorAll(".hub-fleet-update-all .btn")].map((b: any) => b.textContent)).toEqual(["Update 1 Fleet that allows it", "Update 2 Fleets that allow it"]);
  });
  it("zh-TW: the same sentence for one", async () => {
    const zh = page({ storage: { agend_lang: "zh-TW" } }); pages.push(zh); words.setLang("zh-TW");
    await zh.mount(h(v.UpdateAllowedButton, { fleets: [row()], recommended: "2.4.0", revision: 1, client: {} })); await settle(4);
    expect(zh.root.querySelector(".hub-fleet-update-all .btn").textContent).toBe("更新 1 個已允許的 Fleet");
  });

  it("the summary line, in each of its forms, for one Fleet and for two", () => {
    words.setLang("en");
    const cur = row({ versionState: "current" });
    expect([v.summaryText([cur], "2.4.0"), v.summaryText([cur, row({ id: "f2", versionState: "current" })], "2.4.0"),
      v.summaryText([row(), cur], "2.4.0"), v.summaryText([row(), row({ id: "f2" })], "2.4.0"),
      v.summaryText([cur], null), v.summaryText([cur], null, true)]).toEqual([
      "Your Fleet is on the recommended version or newer.", "All 2 Fleets are on the recommended version or newer.",
      "1 of 2 Fleets needs an update.", "2 of 2 Fleets need an update.",
      "1 active Fleet.", "1 active Fleet. Set a recommended version to see whether it is behind."]);
    // M-3177: one Fleet in all, behind — never "1 of 1 Fleets…"; zh-TW the same sentence as for any count.
    expect(v.summaryText([row()], "2.4.0")).toBe("The Fleet needs an update.");
    words.setLang("zh-TW");
    expect(v.summaryText([row()], "2.4.0")).toBe("1 個 Fleet 當中有 1 個需要更新。");
  });
});
