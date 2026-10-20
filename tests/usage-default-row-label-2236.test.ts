/**
 * #2236 follow-up: the default login's usage row beside credential profiles ("Claude (default)", API name unchanged)
 * read "Claude (d…" in the ~300 px ◔ dialog. It now shows like a profile row: the provider name on the title line,
 * "default" in the page's language on its own line under it. The chat and MCP text say "default" in the fleet's language.
 * - The rows: the default row (Claude's, and Codex's beside profiles) carries `defaultLogin`; profile rows and a lone
 *   row don't; the snapshot keeps it on a good, a failed and a timed-out read.
 * - The page: title "Claude", the second line "default" / "預設", the full name as the tooltip; the dialog and the rail
 *   (one component) alike. A profile literally named "default" is still that profile.
 * - The chat and MCP text: "Claude (預設)" in zh-TW, "Claude (default)" in en; a profile row is unchanged.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";
import { fetchAllUsage, providersForConfig, setUsageProviderDeadlineForTests, setUsageProvidersForTests } from "../src/usage/providers.js";
import { setLocale } from "../src/locale.js";
import { renderUsageHtml, renderUsageMarkdown } from "../src/usage/format-rich.js";
import { formatUsageSummary, type UsagePayload } from "../src/usage/usage-api.js";

function configWith(backend: string, profiles: Array<string | null>) {
  const instances: Record<string, unknown> = {};
  profiles.forEach((profile, index) => {
    instances[`agent-${index}`] = {
      working_directory: "/tmp/w", backend,
      ...(profile ? { backend_options: { [backend]: { credential_profile: profile } } } : {}),
    };
  });
  return { defaults: {}, instances } as never;
}
const ok = async () => ({ status: "ok" as const, metrics: [] });

afterEach(() => { setUsageProvidersForTests(null); setUsageProviderDeadlineForTests(null); setLocale("en"); });

describe("the rows", () => {
  it("the default row beside profiles carries defaultLogin (Claude and Codex); profile rows and a lone row don't", () => {
    const claude = providersForConfig(configWith("claude-code", ["team-alpha", null]), [{ id: "claude", name: "Claude", fetch: ok }]);
    expect(claude.map(r => [r.id, r.name, r.profile, r.defaultLogin])).toEqual([
      ["claude", "Claude (default)", undefined, true], ["claude:team-alpha", "Claude (team-alpha)", "team-alpha", undefined]]);
    const codex = providersForConfig(configWith("codex", ["work"]), [{ id: "codex", name: "Codex", fetch: ok }]);
    expect(codex.map(r => [r.id, r.name, r.defaultLogin])).toEqual([["codex", "Codex (default)", true], ["codex:work", "Codex (work)", undefined]]);
    const lone = providersForConfig(configWith("codex", [null]), [{ id: "codex", name: "Codex", fetch: ok }]);
    expect(lone.map(r => [r.name, r.defaultLogin])).toEqual([["Codex", undefined]]);
  });
  it("the snapshot keeps it on a good read, a failed one and one past the deadline", async () => {
    setUsageProviderDeadlineForTests(20);
    for (const fetch of [ok, async () => { throw new Error("boom"); }, () => new Promise<never>(() => {})]) {
      setUsageProvidersForTests([{ id: "claude", name: "Claude", fetch: (home?: string) => (home ? ok() : fetch()) }]);
      const { providers } = await fetchAllUsage(configWith("claude-code", ["team-alpha", null]));
      expect(providers.map(p => [p.id, p.defaultLogin, Object.hasOwn(p, "defaultLogin")])).toEqual([["claude", true, true], ["claude:team-alpha", undefined, false]]);
    }
  });
});

describe("the chat and MCP text", () => {
  const payload = (): UsagePayload => ({ fetchedAt: new Date().toISOString(), providers: [
    { id: "claude", name: "Claude (default)", defaultLogin: true, status: "ok", plan: "Max (20x)", metrics: [] },
    { id: "claude:hsinlin", name: "Claude (hsinlin)", profile: "hsinlin", status: "no-credentials", metrics: [] },
  ] });
  it("say \"default\" in the fleet's language; a profile row is as it was", () => {
    setLocale("zh-TW");
    for (const text of [renderUsageMarkdown(payload()), renderUsageHtml(payload()), formatUsageSummary(payload())]) {
      expect(text).toContain("Claude (預設)");
      expect(text).not.toContain("(default)");
      expect(text).toContain("Claude (hsinlin)");
    }
    setLocale("en");
    for (const text of [renderUsageMarkdown(payload()), renderUsageHtml(payload()), formatUsageSummary(payload())]) expect(text).toContain("Claude (default)");
  });
});

let usage: any, i18n: any;
let pg: AppPage | null = null;
const SNAPSHOT = { fetchedAt: Date.now(), providers: [
  { id: "claude", name: "Claude (default)", defaultLogin: true, status: "ok", plan: "Team Premium (6.25x)", metrics: [] },
  { id: "claude:hsinlin", name: "Claude (hsinlin)", profile: "hsinlin", status: "ok", plan: "Max (20x)", metrics: [] },
  { id: "claude:default", name: "Claude (default)", profile: "default", status: "ok", metrics: [] },
  { id: "codex", name: "Codex (default)", status: "ok", metrics: [] },
] };
beforeAll(async () => {
  const p0 = page({ storage: { agend_tour_done: "1" } });
  usage = await import("/assets/usage-dialog.js");
  i18n = await import("/assets/app-i18n.js");
  p0.restore();
});
afterEach(async () => { if (pg) { await pg.unmount(); pg.restore(); pg = null; } i18n.setLang("en"); });

describe("the page", () => {
  it("providerTitle: the default row is the provider name and \"default\" in the page's language", () => {
    expect(usage.providerTitle({ name: "Claude (default)", defaultLogin: true })).toEqual({ base: "Claude", profile: "default" });
    i18n.setLang("zh-TW");
    expect(usage.providerTitle({ name: "Claude (default)", defaultLogin: true })).toEqual({ base: "Claude", profile: "預設" });
    expect(usage.providerTitle({ name: "Claude (default)", profile: "default" }), "a profile named default is that profile").toEqual({ base: "Claude", profile: "default" });
    expect(usage.providerTitle({ name: "Claude (default)", profile: "default", defaultLogin: true }), "a profile wins over the flag").toEqual({ base: "Claude", profile: "default" });
    expect(usage.providerTitle({ name: "Codex (default)" }), "no flag: the name as it is").toEqual({ base: "Codex (default)", profile: "" });
    expect(usage.providerTitle({ name: "Claude", defaultLogin: true }), "a flag on a name without the suffix: as it is").toEqual({ base: "Claude", profile: "" });
  });
  for (const [lang, word] of [["en", "default"], ["zh-TW", "預設"]] as const) {
    it(`rendered (${lang}): "Claude" on the title line beside the plan, "${word}" on its own line, the full name as the tooltip`, async () => {
      pg = page({ storage: { agend_tour_done: "1" } });
      i18n.setLang(lang);
      (globalThis as any).fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => SNAPSHOT });
      await pg.mount(h(usage.UsageBody, { owner: `t2236-${lang}` }));
      await settle(3);
      const [def, prof, named, codex] = pg.root.querySelectorAll(".u-provider") as any[];
      const strong = def.querySelector(".u-head strong"), line = def.querySelector(".u-profile");
      expect([strong.textContent, strong.getAttribute("title"), line.textContent, line.getAttribute("title")]).toEqual(["Claude", "Claude (default)", word, "Claude (default)"]);
      expect(line.parentNode, "its own line under the head, not beside the badge").toBe(def);
      expect(def.querySelector(".u-head").textContent, "never \"(default)\" or \"(d…\" on the title line").not.toMatch(/\(d/);
      expect(def.querySelector(".u-head .u-plan").textContent).toContain("Team ×6.25");
      expect([prof.querySelector(".u-head strong").textContent, prof.querySelector(".u-profile").textContent]).toEqual(["Claude", "hsinlin"]);
      expect([named.querySelector(".u-head strong").textContent, named.querySelector(".u-profile").textContent], "a profile named default").toEqual(["Claude", "default"]);
      expect([codex.querySelector(".u-head strong").textContent, codex.querySelector(".u-profile")]).toEqual(["Codex (default)", null]);
    });
  }
});
