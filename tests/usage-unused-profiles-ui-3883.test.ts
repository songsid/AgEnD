import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
let usage: any, words: any;
const pages: AppPage[] = [];
beforeAll(async () => {
  const p = page();
  usage = await import("/assets/usage-dialog.js"); words = await import("/assets/app-i18n.js"); p.restore();
});
afterEach(async () => { for (const p of pages.splice(0)) { await p.unmount(); p.restore(); } vi.unstubAllGlobals(); });
it.each([["en", false], ["en", true], ["zh-TW", false], ["zh-TW", true]])("web usage keeps the unused profile note and quota (%s, compact=%s)", async (language, compact) => {
  const p = page({ storage: { agend_lang: language } }); pages.push(p);
  words.setLang(language, { store: false }); usage.setUsageCompact(compact);
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ fetchedAt: new Date().toISOString(), providers: [{ id: "codex:full", name: "Codex (full)", profile: "full", noAgents: true, status: "ok", metrics: [{ label: "Weekly", type: "percent", used: 100 }, { label: "Rate limit resets", type: "count", value: 3, unit: "available" }] }] }) })));
  await p.mount(h(usage.UsageBody, { owner: "" })); await settle(20);
  expect(p.root.textContent).toContain("full");
  expect(p.root.textContent).toContain(language === "en" ? "No agents on this profile" : "此帳號目前沒有 Agent");
  expect(p.root.textContent).toContain("100%");
  if (!compact) { expect(p.root.textContent).toContain("Rate limit resets"); expect(p.root.textContent).toContain("3"); }
});
