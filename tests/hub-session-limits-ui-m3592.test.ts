/**
 * M-3592: Administration → Sign-in (hub-session-limits.js): two lengths from lists within the server's bounds,
 * defaults marked, an idle length longer than the sign-in not offered, saved with the read's revision; a conflict
 * reloads; nothing drawn when the setting can't be read (an older Hub, or not an administrator). en and zh-TW.
 */
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
let ui: any, words: any;
const pages: AppPage[] = [];
beforeAll(async () => { const p = page(); ui = await import("/ui/js/hub-session-limits.js"); words = await import("/assets/app-i18n.js"); p.restore(); });
afterEach(async () => { for (const p of pages.splice(0)) { await p.unmount(); p.restore(); } vi.restoreAllMocks(); });
const BOUNDS = { absolute: { min: 60, max: 10080, default: 480 }, idle: { min: 15, max: 1440, default: 60 } };
const view = (over: any = {}) => ({ ok: true, absoluteMinutes: 480, idleMinutes: 60, revision: 0, configured: false, setAt: null, bounds: BOUNDS, ...over });
async function mount(language = "en", client: any = {}) {
  const p = page({ url: "http://127.0.0.1/ui/hub/admin", storage: { agend_lang: language } }); pages.push(p); words.setLang(language, { store: false });
  const c = { sessionLimits: vi.fn(async () => view()), saveSessionLimits: vi.fn(async (b: any) => view({ ...b, revision: 1, configured: true })), ...client };
  await p.mount(h(ui.HubSessionLimitsCard, { client: c })); await settle(10);
  return { p, c };
}
const select = (p: AppPage, cls: string) => p.root.querySelector(`select.${cls}`);
const options = (p: AppPage, cls: string) => [...select(p, cls).querySelectorAll("option")].map((o: any) => ({ value: Number(o.value), text: o.textContent, disabled: !!o.disabled }));
const pick = (el: any, value: number) => { el.value = String(value); fire(el, "change"); };

it.each([["en", "Sign-in", "8 hours (default)", "1 hour (default)", "7 days", "15 minutes"], ["zh-TW", "登入時間", "8 小時（預設）", "1 小時（預設）", "7 天", "15 分鐘"]])(
  "%s: the card, its two lists within the bounds, the defaults marked, and what changes when", async (language, title, absDefault, idleDefault, week, quarter) => {
    const { p } = await mount(language);
    expect(p.root.querySelector("h3")?.textContent).toBe(title);
    const abs = options(p, "hub-session-absolute"), idle = options(p, "hub-session-idle");
    expect(abs.map((o) => o.value)).toEqual([60, 120, 240, 480, 720, 1440, 4320, 10080]);
    expect(idle.map((o) => o.value)).toEqual([15, 30, 60, 120, 240, 480, 1440]);
    for (const o of [...abs, ...idle]) expect(o.value >= 15 && o.value <= 10080).toBe(true);
    expect(abs.find((o) => o.value === 480)?.text).toBe(absDefault);
    expect(idle.find((o) => o.value === 60)?.text).toBe(idleDefault);
    expect(abs.at(-1)?.text).toBe(week); expect(idle[0]?.text).toBe(quarter);
    expect(p.root.querySelectorAll("p.note")).toHaveLength(2);
    expect((p.root.querySelector("button.hub-session-save") as any).disabled).toBe(true);           // nothing changed yet
  });

it("an idle length longer than the sign-in is not offered; saving sends the read's revision and shows Saved", async () => {
  const { p, c } = await mount();
  pick(select(p, "hub-session-absolute"), 120); await settle(5);
  const idle = options(p, "hub-session-idle");
  expect(idle.filter((o) => o.disabled).map((o) => o.value)).toEqual([240, 480, 1440]);
  pick(select(p, "hub-session-idle"), 30); await settle(5);
  fire(p.root.querySelector("button.hub-session-save"), "click"); await settle(10);
  expect(c.saveSessionLimits).toHaveBeenCalledWith({ absoluteMinutes: 120, idleMinutes: 30, ifRevision: 0 });
  expect(p.root.querySelector('[role="status"]')?.textContent).toBe("Saved.");
});

it("a conflict says so and shows the current setting; a refusal is said in plain words", async () => {
  let reads = 0;
  const { p, c } = await mount("en", {
    sessionLimits: vi.fn(async () => (reads++ ? view({ absoluteMinutes: 240, idleMinutes: 30, revision: 2, configured: true }) : view())),
    saveSessionLimits: vi.fn(async () => ({ ok: false, status: 409, code: "revision-conflict" })),
  });
  pick(select(p, "hub-session-absolute"), 120); await settle(5);
  fire(p.root.querySelector("button.hub-session-save"), "click"); await settle(20);
  expect(p.root.querySelector('[role="alert"]')?.textContent).toContain("Someone else changed this");
  expect(c.sessionLimits).toHaveBeenCalledTimes(2);
  expect(select(p, "hub-session-absolute").value).toBe("240");
});

it("a saved length not in the list is offered as it is", async () => {
  const { p } = await mount("en", { sessionLimits: vi.fn(async () => view({ absoluteMinutes: 90, idleMinutes: 45, revision: 3, configured: true })) });
  expect(options(p, "hub-session-absolute").map((o) => o.value)).toContain(90);
  expect(options(p, "hub-session-idle").find((o) => o.value === 45)?.text).toBe("45 minutes");
});

it.each([["a 404 (an older Hub)", { ok: false, status: 404 }], ["a 403 (not an administrator)", { ok: false, status: 403 }], ["no client method", undefined]])(
  "nothing is drawn when the setting can't be read: %s", async (_why, answer) => {
    const { p } = await mount("en", { sessionLimits: answer === undefined ? undefined : vi.fn(async () => answer) });
    expect(p.root.querySelector(".hub-session-limits")).toBeNull();
  });
