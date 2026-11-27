/**
 * Beta.28 wording pass (the leader's capture notes): Settings → Access and security's request-based approvals card.
 * - While turning it on isn't available (enableUnavailable, #4597) the off switch shows no "can't downgrade after turning
 *   it on" warning; an already-on owner (everActivated) still sees the downgrade note.
 * - The words: EN blocked "aren't on yet" (matches zh 「尚未開啟」); zh ownersWork asks to wait for the work, not end it;
 *   the server's blocked result names the path as 「設定 → 存取與安全」.
 */
import { afterEach, expect, it, vi } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
const pages: AppPage[] = [];
afterEach(async () => { for (const p of pages.splice(0)) { await p.unmount(); p.restore(); } vi.unstubAllGlobals(); });
const mount = async (view: Record<string, unknown>, language = "en") => {
  const p = page(); pages.push(p);
  const words = await import("/assets/app-i18n.js") as any; words.setLang(language, { store: false });
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => view })));
  const ui = await import("/ui/js/request-context-control.js") as any;
  await p.mount(h(ui.RequestContextSettings, {})); await settle(8);
  return { p, ui };
};
it.each(["en", "zh-TW"])("while On isn't available, the off switch shows no downgrade warning (%s)", async (language) => {
  const { p, ui } = await mount({ revision: 1, enabled: false, everActivated: false, attempted: false, phase: "off", canChange: true, blockers: [], enableUnavailable: true }, language);
  expect(p.root.querySelector(".request-context-control .notice.warn")).toBeNull();
  expect(p.root.textContent).not.toContain(ui.requestContextControlText("floorBefore"));
  expect(p.root.textContent).toContain(ui.requestContextControlText("enableUnavailable"));
});
it("an already-on owner still sees the downgrade note", async () => {
  const on = await mount({ revision: 2, enabled: true, everActivated: true, attempted: true, phase: "on", canChange: true, blockers: [], enableUnavailable: true });
  expect(on.p.root.querySelector(".request-context-control .notice.warn")?.textContent).toBe(on.ui.requestContextControlText("floor"));
});
it("an off switch that can be turned on still warns before it", async () => {
  const offable = await mount({ revision: 3, enabled: false, everActivated: false, attempted: false, phase: "off", canChange: true, blockers: [], enableUnavailable: false });
  expect(offable.p.root.querySelector(".request-context-control .notice.warn")?.textContent).toBe(offable.ui.requestContextControlText("floorBefore"));
});
it("the words: EN blocked matches zh; zh asks to wait for the agents' work; the blocked result's path uses one quote pair", async () => {
  const ui = await import("/ui/js/request-context-control.js") as any;
  const words = await import("/assets/app-i18n.js") as any;
  words.setLang("en", { store: false }); expect(ui.requestContextControlText("blocked")).toBe("Request-based approvals aren't on yet.");
  words.setLang("zh-TW", { store: false });
  expect(ui.requestContextControlText("ownersWork", "A")).toMatch(/^請先等這些 Agent 完成目前的工作：A。/);
  expect(ui.requestContextControlText("ownersWork", "A")).not.toContain("結束");
  words.setLang("en", { store: false });
  const { setLocale, t } = await import("../src/locale.js");
  setLocale("zh-TW");
  try { expect(t("settings_confirm.result.request_context_blocked")).toBe("尚未開啟：還在等候「設定 → 存取與安全」裡列出的項目。"); } finally { setLocale("en"); }
});
