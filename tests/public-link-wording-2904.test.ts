/**
 * #2904 (follow-up of #2902): the words a page shows about "the public link" are true over either kind — a temporary
 * one (quick tunnel) and the admin's permanent hostname (named tunnel) — with no new page state (leader, 2026-11-01).
 * The session hint says what applies to a session over any public link: the gateway policy (8 h, 30 min idle), never
 * longer than the local setting or the link itself — the same for both kinds (web-session.ts policyFor / create).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { page, type AppPage } from "./helpers/app-harness.js";
import { DEFAULT_SESSION_POLICY } from "../src/web-session.js";

let p: AppPage, i18n: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/settings" });
  i18n = await import("/assets/app-i18n.js");
  await import("/ui/js/settings-strings.js");
  await import("/ui/js/settings-public-session-strings.js");
  await import("/assets/web-authorize.js");
});
afterAll(() => { i18n.setLang("en"); p.restore(); });
const both = (key: string): [string, string] => { i18n.setLang("en"); const en = i18n.t(key); i18n.setLang("zh-TW"); const zh = i18n.t(key); i18n.setLang("en"); return [en, zh]; };

describe("#2904: a page over a public link never calls a permanent link temporary", () => {
  it.each(["settings.webPublicRefused", "settings.cssPublicLink", "settings.publicSessionHint", "settings.publicSessionCeiling", "settings.publicSessionLimitNote", "webauth.reason_public_link"])("%s says nothing about 'temporary' for either kind", (key) => {
    const [en, zh] = both(key);
    expect([en, zh].every(s => s && s !== key)).toBe(true);
    expect([/temporary public link/i.test(en), /臨時公開連結/.test(zh)]).toEqual([false, false]);
  });
  it("the refusals say 'a public link' / 「公開連結」", () => {
    expect(both("settings.webPublicRefused")).toEqual(["Web settings can't be changed over a public link. Open the dashboard at its own address to change them.",
      "無法透過公開連結變更網頁設定。請從儀表板本身的網址開啟後再變更。"]);
    expect(both("settings.cssPublicLink")).toEqual(["Custom CSS isn't available over a public link.", "透過公開連結無法使用自訂 CSS。"]);
    expect(both("webauth.reason_public_link")).toEqual(["This sign-in can't be authorized over this link.", "這個登入無法透過這個連結授權。"]);
  });
  // #2905 review (Prism P2): these settings cap an ADMIN's session over the link; a guest's follows the guest settings
  // (web-session.ts policyFor: shorter(gateway, local) for an admin, shorter(gateway, guestPolicy()) for a guest).
  // #3708: the gateway policy is configurable now; the words give its defaults (8 h, 30 min) and the account ceiling.
  it("the session words give the gateway defaults (8 h, 30 min idle), the link's end, and these settings for an admin only", () => {
    const g = DEFAULT_SESSION_POLICY.gateway, hours = g.absoluteMs / 3_600_000, minutes = g.idleMs / 60_000;
    expect([hours, minutes]).toEqual([8, 30]);
    const [en, zh] = both("settings.publicSessionHint");
    expect(en).toContain("An admin's session over the public link also never lasts longer than these settings (a guest's follows the guest settings).");
    expect(zh).toContain("管理員透過公開連結的 session 也不會超過這裡的設定（訪客依訪客設定）。");
    const [enNote, zhNote] = both("settings.publicSessionLimitNote");
    expect(enNote).toContain(`(${hours} hours, ${minutes} minutes unused by default)`);
    expect(enNote).toContain("never outlive the link");
    expect(zhNote).toContain(`預設 ${hours} 小時、閒置 ${minutes} 分鐘`);
    expect(zhNote).toContain("不會超過連結期限");
    expect([/\b4 h\b/.test(en + enNote), /4 小時/.test(zh + zhNote)]).toEqual([false, false]);
  });
});
