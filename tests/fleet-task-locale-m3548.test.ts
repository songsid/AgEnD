import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { page, type AppPage } from "./helpers/app-harness.js";
let p: AppPage;
let i18n: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/fleet/tasks" });
  i18n = await import("/assets/app-i18n.js");
  await import("/ui/js/panel-fleet.js");
  await import("/ui/js/fleet-task-card.js");
});
afterAll(() => p?.restore());
describe("Fleet task copy in the registered UI dictionaries (M-3548)", () => {
  it("translates both zh-TW tabs alongside their siblings", () => {
    expect(["tasks", "teams", "schedules", "org"].map(k => i18n.tIn("zh-TW", `fleet.${k}`)))
      .toEqual(["任務", "團隊", "排程", "組織圖"]);
  });
  it("retains the English tab labels", () => {
    expect(["tasks", "teams"].map(k => i18n.tIn("en", `fleet.${k}`))).toEqual(["Tasks", "Teams"]);
  });
  it("uses spaced middle dots in the zh-TW card footer without losing values", () => {
    i18n.setLang("zh-TW", { store: false });
    const text = i18n.t("taskcard.opened", "Example owner", "建立時間", "更新時間");
    expect(text).toBe("Example owner 開的 · 建立時間 · 最後更新 更新時間");
    expect(text).not.toContain("・");
  });
  it("retains the English footer and interpolation", () => {
    i18n.setLang("en", { store: false });
    expect(i18n.t("taskcard.opened", "Example owner", "created", "updated"))
      .toBe("Opened by Example owner created · changed updated");
  });
});
