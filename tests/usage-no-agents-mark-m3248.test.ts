/**
 * M-3248 (the user): in the AI usage panel a login no agent uses said 「此帳號目前沒有 Agent」 as a line of text beside its
 * name. It is a quiet ⓘ there now. M-3443: no hover-only mark —
 * - A compact row (itself a button that opens the login's card): the ⓘ only drawn (aria-hidden), never a second control;
 *   its words are part of the row's name (read with it); a tap on the row opens the card.
 * - The full card: the shared info icon (info-tip.js) beside the profile's name (or the provider's, for the default
 *   login) — a button reached with Tab: its words on a focus, a hover or a tap; a second tap, Escape (this bubble only) or a
 *   click elsewhere hides them.
 * - Every mode of #4054's groups that shows rows: every window, and one line per login.
 * /api/ai-usage is a scripted fake: no server, no vendor call.
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
const cardOf = (p: AppPage, name: string) => [...p.root.querySelectorAll(".u-provider")].find((s: any) => (s.querySelector(".u-profile-name") ?? s.querySelector(".u-profile") ?? s.querySelector(".u-head strong"))?.textContent === name) as any;
const bubble = (p: AppPage) => p.root.querySelector(".u-na-tip .info-tip-body") as any;
const shown = (p: AppPage) => { const b = bubble(p); return b && !b.hasAttribute("hidden") ? b.textContent : null; };
// The mini DOM names a listener by the prop's own name (onMouseEnter → "MouseEnter"); a browser by the lower-case event.
const pointer = (el: any, type: "enter" | "leave") => { fire(el, `mouse${type}`, { bubbles: false }); fire(el, `Mouse${type[0].toUpperCase()}${type.slice(1)}`, { bubbles: false }); };

it.each(["en", "zh-TW"] as const)("compact rows (%s): the ⓘ only drawn beside the name, its words in the row's name; no second control", async (lang) => {
  const p = await mount(lang, true);
  const wii = rowOf(p, "wii"), mark = wii.querySelector(".u-na");
  expect([mark.tagName, mark.getAttribute("aria-hidden"), mark.getAttribute("role")]).toEqual(["SPAN", "true", null]);
  expect(mark.previousSibling?.className, "right of the name").toBe("u-crow-name");
  expect(wii.querySelector(".sr-only")?.textContent, "read with the row").toBe(WORDS[lang]);
  expect(wii.querySelectorAll("button").length, "no control inside the row's button").toBe(0);
  expect(p.root.querySelector(".u-crow .note"), "the old inline note").toBeNull();
  expect(rowOf(p, "yanxian").querySelector(".u-na"), "a login an agent uses has none").toBeNull();
  // One line per login (#4054): still there.
  usage.setGroupMode("Codex", "compact"); await settle(10);
  expect(rowOf(p, "wii").classList.contains("is-one")).toBe(true);
  expect(rowOf(p, "wii").querySelector(".sr-only")?.textContent).toBe(WORDS[lang]);
});

it("compact row: a tap on the row (its ⓘ too) opens the card, where the ⓘ is the shared info icon", async () => {
  const p = await mount("en", true);
  fire(rowOf(p, "wii").querySelector(".u-na"), "click"); await settle();
  expect(cardOf(p, "wii")?.querySelector(".u-na-tip .info-tip-btn")?.tagName).toBe("BUTTON");
});

it.each(["en", "zh-TW"] as const)("full card (%s): the shared info icon beside the profile's name (the provider's for a default login); focus shows the words, blur hides them", async (lang) => {
  const p = await mount(lang, false);
  const wii = cardOf(p, "wii");
  const btn = wii.querySelector(".u-profile .u-na-tip .info-tip-btn");
  expect([btn.tagName, btn.getAttribute("type"), btn.getAttribute("aria-label"), btn.getAttribute("aria-expanded")]).toEqual(["BUTTON", "button", WORDS[lang], "false"]);
  expect(wii.querySelector(".u-profile-name")?.textContent).toBe("wii");
  expect(wii.querySelector("p.note"), "no line of text under the name").toBeNull();
  expect(cardOf(p, "Kiro").querySelector(".u-head .u-na-tip .info-tip-btn")?.getAttribute("aria-label"), "a default login: beside the provider's name").toBe(WORDS[lang]);
  expect(cardOf(p, "yanxian").querySelector(".u-na-tip")).toBeNull();
  expect(shown(p), "closed").toBeNull();
  fire(btn, "focus", { bubbles: false }); await settle();
  expect([shown(p), btn.getAttribute("aria-expanded")]).toEqual([WORDS[lang], "true"]);
  fire(btn, "blur", { bubbles: false }); await settle();
  expect(shown(p)).toBeNull();
});

it("full card: a tap keeps it open (the pointer leaving keeps it); a second tap, Escape (the bubble only) or a click elsewhere hides it", async () => {
  const p = await mount("en", false);
  const btn = () => cardOf(p, "wii").querySelector(".u-na-tip .info-tip-btn");
  const click = fire(btn(), "click"); await settle();
  expect([shown(p), click.defaultPrevented]).toEqual([WORDS.en, true]);
  pointer(btn(), "leave"); await settle();
  expect(shown(p), "pinned by the tap").toBe(WORDS.en);
  fire(btn(), "click"); await settle();
  expect(shown(p), "a second tap").toBeNull();
  fire(btn(), "click"); await settle();
  const esc = fire(p.document, "keydown", { key: "Escape" }); await settle();
  expect([shown(p), esc.propagationStopped], "Escape closes the words, not the dialog around them").toEqual([null, true]);
  fire(btn(), "click"); await settle();
  fire(p.root.querySelector(".u-foot"), "click"); await settle();
  expect(shown(p), "a click elsewhere").toBeNull();
});
