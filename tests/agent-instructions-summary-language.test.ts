/**
 * The confirmation of a long systemPrompt carries display descriptors (like every other summary line), so the page shows its
 * words ("characters", "fingerprint", "not set") in the page's language, whatever language the fleet runs in.
 */
import { afterEach, beforeAll, expect, it } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { settingsChangeDiff } from "../src/settings-change.js";
import { getLocale, setLocale, t } from "../src/locale.js";
const originalLocale = getLocale();
let shell: any, app: any, words: any; const pages: AppPage[] = [];
beforeAll(async () => { const p = page(); shell = await import("/assets/app-shell.js"); app = await import("/assets/app-store.js"); words = await import("/assets/app-i18n.js"); p.restore(); });
afterEach(async () => { for (const p of pages.splice(0)) { await p.unmount(); p.restore(); } app.appStore.set({ pendingChanges: [] }); words.setLang("en", { store: false }); setLocale(originalLocale); });

const effect = (systemPrompt?: string) => ({ fleet: { instances: { dev: { working_directory: "/w", ...(systemPrompt === undefined ? {} : { systemPrompt }) } } } });
const long = "# Role\n\n" + "You review pull requests for the payments service. ".repeat(8);

function diff(locale: "en" | "zh-TW") {
  setLocale(locale);
  return settingsChangeDiff(effect("short"), effect(long), { operation: "PATCH /api/settings/fleet/instances/dev" })!;
}

it("the line and its parts say the same thing, in the fleet's language", () => {
  for (const locale of ["en", "zh-TW"] as const) {
    const d = diff(locale), line = d.summary.find(l => l.includes("systemPrompt"))!;
    const i = d.summary.indexOf(line), desc = (d as any).summary_i18n[i];
    expect(desc.fallback).toBe(line);
    expect(desc.parts.map((part: any) => typeof part === "string" ? part : t(part.key, ...part.args)).join("")).toBe(line);
    expect(line).toMatch(/[0-9a-f]{12}/);
  }
});

it.each([["zh-TW", "字", "指紋"], ["en", "characters", "fingerprint"]])("a %s page shows it as %s / %s, whatever the fleet's language", async (language, chars, fp) => {
  const d = diff(language === "en" ? "zh-TW" : "en");
  const p = page({ storage: { agend_lang: language } }); pages.push(p); words.setLang(language, { store: false });
  const pending = { id: "c".repeat(32), state: "pending", summary: d.summary, summary_i18n: (d as any).summary_i18n, deadline: Date.now() + 60000, confirmation: { kind: "web", code: "same-operation" }, applyNow: () => {} };
  app.appStore.set({ pendingChanges: [pending] }); await p.mount(h(shell.PendingChanges, { inline: true })); await settle();
  const shown = p.root.querySelector(".pending-summary")!.textContent as string;
  expect(shown).toContain(chars); expect(shown).toContain(fp);
  expect(shown).not.toContain(language === "en" ? "指紋" : "fingerprint");
  expect(shown).toContain("systemPrompt");
});
