/**
 * M-3248 (the user): in the AI usage panel a login no agent uses said 「此帳號目前沒有 Agent」 as a line of text beside its
 * name. It is a quiet ⓘ there now, its words on a hover, a focus or a tap; a screen reader reads them as its name.
 * - A compact row (itself a button that opens the login's card): an image named by the words, never a second button; a
 *   tap shows the words and leaves the row closed; a second tap, Escape or a click elsewhere hides them.
 * - The full card: a button beside the profile's name (or the provider's, for the default login), reached with Tab.
 * - Every mode of #4054's groups that shows rows: every window, and one line per login.
 * The words are in the page only while shown. /api/ai-usage is a scripted fake: no server, no vendor call.
 */
import { afterEach, beforeAll, expect, it } from "vitest";
import { page, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

const pct = (label: string, used: number) => ({ type: "percent", label, used, windowMs: 168 * 3_600_000 });
const PROVIDERS = [
  { id: "codex", name: "Codex", status: "ok", metrics: [pct("Weekly", 86)] },
  { id: "codex:wii", name: "Codex (wii)", profile: "wii", noAgents: true, status: "ok", metrics: [pct("Weekly", 45)] },
  { id: "codex:yanxian", name: "Codex (yanxian)", profile: "yanxian", status: "ok", metrics: [pct("Weekly", 18)] },
  { id: "kiro", name: "Kiro", noAgents: true, status: "ok", metrics: [pct("Monthly", 40)] },
];
const WORDS = { en: "No agents on this profile", "zh-TW": "此帳號目前沒有 Agent" } as const;

let usage: any, i18n: any, htm: any, pg: AppPage | null = null;
beforeAll(async () => {
  const p0 = page({ storage: { agend_tour_done: "1" } });
  p0.document.documentElement.setAttribute("data-prefs", JSON.stringify({ rev: 1, values: {} }));
  usage = await import("/assets/usage-dialog.js");
  i18n = await import("/assets/app-i18n.js");
  htm = await import("/assets/app-html.js");
  p0.restore();
});
afterEach(async () => {
  if (pg) { await pg.unmount(); pg.restore(); pg = null; }
  usage?.setGroupMode("Codex", "expanded");
  usage?.usageViewStore.set({ compact: false });
  i18n?.setLang("en");
});
async function mount(lang: "en" | "zh-TW", compact: boolean) {
  pg = page({ storage: { agend_tour_done: "1" } });
  i18n.setLang(lang);
  usage.usageViewStore.set({ compact });
  (globalThis as any).fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ fetchedAt: new Date().toISOString(), providers: PROVIDERS }) });
  await pg.mount(htm.html`<${usage.UsageBody} owner="" />`);
  await settle(20);
  return pg;
}
const rowOf = (p: AppPage, name: string) => [...p.root.querySelectorAll(".u-crow")].find((r: any) => r.querySelector(".u-crow-name")?.textContent === name) as any;
const cardOf = (p: AppPage, name: string) => [...p.root.querySelectorAll(".u-provider")].find((s: any) => (s.querySelector(".u-profile") ?? s.querySelector(".u-head strong"))?.textContent === name) as any;
const tip = (p: AppPage) => p.root.querySelector(".u-na-tip");
// The mini DOM names a listener by the prop's own name (onMouseEnter → "MouseEnter"); a browser by the lower-case event.
const pointer = (el: any, type: "enter" | "leave") => { fire(el, `mouse${type}`, { bubbles: false }); fire(el, `Mouse${type[0].toUpperCase()}${type.slice(1)}`, { bubbles: false }); };

it.each(["en", "zh-TW"] as const)("compact rows (%s): a quiet image named by the words, beside the name; no line of text", async (lang) => {
  const p = await mount(lang, true);
  const wii = rowOf(p, "wii"), mark = wii.querySelector(".u-na");
  expect([mark.tagName, mark.getAttribute("role"), mark.getAttribute("aria-label")]).toEqual(["SPAN", "img", WORDS[lang]]);
  expect(mark.previousSibling?.className, "right of the name").toBe("u-crow-name");
  expect(p.root.textContent, "the words are not in the page while hidden").not.toContain(WORDS[lang]);
  expect(p.root.querySelector(".u-crow .note"), "the old inline note").toBeNull();
  expect(rowOf(p, "yanxian").querySelector(".u-na"), "a login an agent uses has none").toBeNull();
  // One line per login (#4054): still there.
  usage.setGroupMode("Codex", "compact"); await settle(10);
  expect(rowOf(p, "wii").classList.contains("is-one")).toBe(true);
  expect(rowOf(p, "wii").querySelector(".u-na")?.getAttribute("aria-label")).toBe(WORDS[lang]);
});

it("compact row: a hover shows the words and leaving hides them; a tap shows them without opening the row, a second tap, Escape or a click elsewhere hides them", async () => {
  const p = await mount("en", true);
  let mark = rowOf(p, "wii").querySelector(".u-na");
  pointer(mark, "enter"); await settle();
  expect(tip(p)?.textContent).toBe(WORDS.en);
  expect(tip(p)?.getAttribute("aria-hidden"), "the mark's name already says it").toBe("true");
  pointer(mark, "leave"); await settle();
  expect(tip(p)).toBeNull();

  const click = fire(mark, "click"); await settle();
  expect([tip(p)?.textContent, click.defaultPrevented], "a tap: the words").toEqual([WORDS.en, true]);
  expect(rowOf(p, "wii").getAttribute("aria-expanded"), "the row stays closed (no card)").toBe("false");
  expect(cardOf(p, "wii")).toBeUndefined();
  pointer(mark, "leave"); await settle();
  expect(tip(p), "pinned by the tap: the pointer leaving keeps it").not.toBeNull();
  fire(mark, "click"); await settle();
  expect(tip(p), "a second tap").toBeNull();

  fire(mark, "click"); await settle();
  const esc = fire(p.document, "keydown", { key: "Escape" }); await settle();
  expect([tip(p), esc.propagationStopped], "Escape closes the words, not the dialog around them").toEqual([null, true]);
  mark = rowOf(p, "wii").querySelector(".u-na");
  fire(mark, "click"); await settle();
  fire(p.root.querySelector(".u-foot"), "click"); await settle();
  expect(tip(p), "a click elsewhere").toBeNull();
  // The row itself still opens the card.
  fire(rowOf(p, "wii"), "click"); await settle();
  expect(cardOf(p, "wii")?.querySelector(".u-na")?.tagName).toBe("BUTTON");
});

it.each(["en", "zh-TW"] as const)("full card (%s): a button beside the profile's name (the provider's for a default login); focus shows the words, blur hides them", async (lang) => {
  const p = await mount(lang, false);
  const wii = cardOf(p, "wii");
  const mark = wii.querySelector(".u-profile .u-na");
  expect([mark.tagName, mark.getAttribute("type"), mark.getAttribute("aria-label")]).toEqual(["BUTTON", "button", WORDS[lang]]);
  expect(wii.querySelector(".u-profile-name")?.textContent).toBe("wii");
  expect(wii.querySelector(".u-profile").textContent, "the profile line is the name alone").toBe("wii");
  expect(wii.querySelector("p.note"), "no line of text under the name").toBeNull();
  expect(cardOf(p, "Kiro").querySelector(".u-head .u-na")?.getAttribute("aria-label"), "a default login: beside the provider's name").toBe(WORDS[lang]);
  expect(cardOf(p, "yanxian").querySelector(".u-na")).toBeNull();
  expect(cardOf(p, "yanxian").querySelector(".u-profile").textContent).toBe("yanxian");
  fire(mark, "focus", { bubbles: false }); await settle();
  expect(tip(p)?.textContent).toBe(WORDS[lang]);
  fire(mark, "blur", { bubbles: false }); await settle();
  expect(tip(p)).toBeNull();
});
