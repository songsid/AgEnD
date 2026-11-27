/**
 * M-3770 S-241 (Lumen's points 3 and 8 on the Phase 1 update card):
 *  3. General's chat card says what the web card says: "if the new version won't start", and zh-TW's scheduled line in
 *     the web's words.
 *  8. Once the admin has answered (waiting for idle, scheduled), a phone shows the banner as one line — the short words
 *     and Change, which opens the full line. The desk is unchanged (app.css hides the short words and Change there).
 *     mini-dom has no layout: the classes, the toggle and the stylesheet's rules are checked here; the captures show it.
 */
import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { setLocale, t as serverT } from "../src/locale.js";

type Req = { method: string; url: string; body: any };
let reqs: Req[] = [];
let answer: (r: Req) => { status?: number; body?: unknown } | undefined = () => undefined;
async function fetchFake(url: string, init: any = {}) {
  const r: Req = { method: init.method || "GET", url, body: init.body ? JSON.parse(init.body) : null };
  reqs.push(r);
  const a = answer(r) ?? (url === "/api/settings/restart-pending" ? { body: { pending: false } } : { status: 404, body: {} });
  const status = a.status ?? 200;
  return { ok: status >= 200 && status < 300, status, json: async () => a.body, text: async () => JSON.stringify(a.body) };
}
const CARD = (extra: Record<string, unknown> = {}) => ({ version: "2.4.1", channel: "beta", installable: true, state: "offered", ...extra });
const SELF = { class: "self", checkedAt: Date.now(), pressHere: true, checks: [{ id: "P1", ok: true }, { id: "P3", ok: true }] };
const ADMIN = (extra: Record<string, unknown> = {}) => ({ admin: true, current: "2.4.0", offer: { version: "2.4.1", channel: "beta", installable: true },
  checked_at: Date.now(), check_failed: false, progress: null, now: Date.now(), card: CARD(), preflight: SELF, ...extra });
// Thursday 26 Nov 2026, 22:00 local.
const AT = new Date(2026, 10, 26, 22, 0, 0, 0).getTime();

let p: AppPage;
let shell: any, upd: any, i18n: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19282/ui/fleet", storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = fetchFake;
  shell = await import("/assets/app-shell.js");
  upd = await import("/assets/app-update.js");
  await import("/assets/update-card-ui.js");
  i18n = await import("/assets/app-i18n.js");
  (await import("/assets/app-nav.js")).startRouter(p.window);
});
beforeEach(async () => {
  await p.unmount();
  reqs = []; answer = () => undefined;
  upd.updateStore.set({ info: null, loadedVersion: null, skew: 0, starting: false, later: null, dismissed: null, reloadDismissed: null, log: null });
});

const panels = () => new Map([["fleet", { load: async () => () => h("div", { class: "panel" }, "fleet") }]]);
const mountShell = async () => { await p.mount(h(shell.Shell, { panels: panels() })); await settle(10); };
const q = (sel: string) => p.root.querySelector(sel) as any;
const fold = () => q(".update-line .uc-fold");
const button = (text: string) => ([...(p.root.querySelectorAll(".update-line button") ?? [])] as any[]).find((b) => b.textContent === text);

describe("S-241 point 8: an answered card is one line on a phone", () => {
  it("waiting for idle: the short words, the full words and Change; Change opens the line and closes it again", async () => {
    answer = r => (r.url === "/ui/update" ? { body: ADMIN({ card: CARD({ state: "waiting-idle", waitingFor: ["Example helper"] }) }) } : undefined);
    await mountShell();
    expect(q(".uc-answered")).toBeTruthy();
    expect(q(".uc-answered").className).toBe("uc-answered");
    expect(q(".uc-answered .update-line")).toBeTruthy();                 // the wrapper holds the banner's own line
    expect(q(".uc-short").textContent).toBe("AgEnD updates when idle");
    expect(q(".uc-long").textContent).toBe("Updating to 2.4.1 as soon as your agents are idle.");
    expect(q(".update-sub").textContent).toBe("Waiting for: Example helper");
    expect([fold().textContent, fold().getAttribute("aria-expanded")]).toEqual(["Change", "false"]);
    expect(["Update now", "Pick a time", "Cancel"].every((b) => !!button(b))).toBe(true);   // still there; the phone hides them closed
    fold().click(); await settle(4);
    expect(q(".uc-answered").className).toBe("uc-answered open");
    expect([fold().textContent, fold().getAttribute("aria-expanded")]).toEqual(["Hide", "true"]);
    fold().click(); await settle(4);
    expect(q(".uc-answered").className).toBe("uc-answered");
    expect(reqs.filter((r) => r.method === "POST")).toEqual([]);           // opening and closing decide nothing
  });
  it("scheduled: the short words name the weekday and the 24-hour time; Change is the last button", async () => {
    answer = r => (r.url === "/ui/update" ? { body: ADMIN({ card: CARD({ state: "scheduled", scheduledAt: AT }) }) } : undefined);
    await mountShell();
    expect(q(".uc-short").textContent).toBe("AgEnD updates Thu 22:00");
    expect(q(".uc-long").textContent).toContain("Updating to 2.4.1 at Thu, Nov 26, 22:00, when your agents are idle.");
    const labels = ([...p.root.querySelectorAll(".update-line .update-actions button")] as any[]).map((b) => b.textContent);
    expect(labels).toEqual(["Update now", "Cancel", "Change"]);
  });
  it("an offered card is not folded: it has no Change and no short words (the admin has not answered yet)", async () => {
    answer = r => (r.url === "/ui/update" ? { body: ADMIN() } : undefined);
    await mountShell();
    expect(q(".update-line")).toBeTruthy();
    expect([q(".uc-answered"), q(".uc-short"), fold()]).toEqual([null, null, null]);
  });
  it("a new state starts closed: opened while waiting, then scheduled → closed again", async () => {
    let info = ADMIN({ card: CARD({ state: "waiting-idle", waitingFor: ["A"] }) });
    answer = r => (r.url === "/ui/update" ? { body: info } : undefined);
    await mountShell();
    fold().click(); await settle(4);
    expect(q(".uc-answered").className).toBe("uc-answered open");
    info = ADMIN({ card: CARD({ state: "scheduled", scheduledAt: AT }) });
    upd.updateStore.set({ info });
    await settle(6);
    expect(q(".uc-short").textContent).toBe("AgEnD updates Thu 22:00");
    expect(q(".uc-answered").className).toBe("uc-answered");
  });
  it("zh-TW: the short words and the toggle", async () => {
    i18n.setLang("zh-TW", { store: false });
    try {
      expect(i18n.t("updatecard.waitingShort")).toBe("AgEnD 閒置時更新");
      expect(i18n.t("updatecard.scheduledShort", "週四 22:00")).toBe("AgEnD 週四 22:00 更新");
      expect([i18n.t("updatecard.foldOpen"), i18n.t("updatecard.foldClose")]).toEqual(["變更", "收起"]);
    } finally { i18n.setLang("en", { store: false }); }
  });
  it("the built-in web-dashboard skill names the folded line's words and toggle as the page shows them (#4558 review)", () => {
    const skill = readFileSync(new URL("../src/general-knowledge/skills/web-dashboard/SKILL.md", import.meta.url), "utf8").replace(/\s+/g, " ");
    const words: string[] = [];
    for (const lang of ["en", "zh-TW"]) {
      i18n.setLang(lang, { store: false });
      try { words.push(i18n.t("updatecard.waitingShort"), i18n.t("updatecard.scheduledShort", lang === "en" ? "Thu 22:00" : "週四 22:00"), i18n.t("updatecard.foldOpen"), i18n.t("updatecard.foldClose")); }
      finally { i18n.setLang("en", { store: false }); }
    }
    for (const w of words) expect(skill, w).toContain(w);
    expect(skill).toContain("Opening or hiding it decides nothing");
  });
  it("the stylesheet: the desk never shows the short words or Change; a closed phone line shows only them", () => {
    const css = readFileSync(new URL("../src/ui/shared/app.css", import.meta.url), "utf8").replace(/\s+/g, " ");
    expect(css).toContain(".uc-answered { display: contents; }");
    expect(css).toContain(".uc-short, .uc-fold { display: none; }");
    const phone = css.slice(css.indexOf("S-241 (Lumen's point 8)"));
    // The app's own phone condition (app-shell.js narrow(): 899 px, or a landscape touch screen), never the banner's 700 px (#4558 review).
    const media = "@media (max-width: 899px), (pointer: coarse) and (max-height: 500px) and (max-width: 1023px) {";
    const shell = readFileSync(new URL("../src/ui/shared/app-shell.js", import.meta.url), "utf8");
    expect(shell).toContain('matchMedia("(max-width: 899px), (pointer: coarse) and (max-height: 500px) and (max-width: 1023px)")');
    expect(phone.indexOf(media), "the compact rules use the shell's phone condition").toBeGreaterThan(-1);
    const block = phone.slice(phone.indexOf(media), phone.indexOf("} }", phone.indexOf(media)) + 3);
    expect(block).toContain(".uc-fold { display: inline-flex; }");
    expect(block).toContain(".uc-answered:not(.open) .update-line { flex-wrap: nowrap; }");
    expect(block).toContain(".uc-answered:not(.open) .uc-long, .uc-answered:not(.open) .update-sub, .uc-answered:not(.open) .update-actions .btn:not(.uc-fold) { display: none; }");
    expect(block).toContain(".uc-answered:not(.open) .uc-short { display: inline; }");
  });
});

describe("S-241 point 3: General's chat card says what the web card says", () => {
  it("the way-back sentence and the scheduled line, word for word, in en and zh-TW", () => {
    for (const lang of ["en", "zh-TW"] as const) {
      setLocale(lang);
      i18n.setLang(lang, { store: false });
      try {
        expect(serverT("update.chatcard.back", "2.4.0")).toBe(i18n.t("updatecard.backPhase1", "2.4.0"));
        expect(serverT("update.chatcard.noWayBack")).toBe(i18n.t("updatecard.noWayBack"));
        expect(serverT("update.chatcard.state_scheduled", "2.4.1", "週四 22:00")).toBe(i18n.t("updatecard.scheduled", "2.4.1", "週四 22:00"));
        expect(serverT("update.chatcard.state_waiting", "2.4.1")).toBe(i18n.t("updatecard.waiting", "2.4.1"));
        expect(serverT("update.chatcard.when_idle")).toBe(i18n.t("updatecard.whenIdle"));
        expect(serverT("update.chatcard.not_now")).toBe(i18n.t("updatecard.notNow"));
      } finally { setLocale("en"); i18n.setLang("en", { store: false }); }
    }
    setLocale("en");
    expect(serverT("update.chatcard.back", "2.4.0")).toBe("Your work continues; if the new version won't start, AgEnD tries to roll back to 2.4.0.");
  });
});
