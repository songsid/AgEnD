/** Owner-only presentation smoke, not provider/platform qualification.
 * Real web handlers + Chromium, private scratch fixture, inert exposure rows and setup holds.
 * REPO=$PWD PW_DIR=<playwright-core prefix> OUT=<artifacts> npx tsx scripts/manual/hub-provider/setup-guidance.mts
 * Exercises fresh/stale shells and truly retained pre-change Hub strings in EN/zh-TW on desk/phone.
 * Never starts a fleet, CLI, Docker or real account.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, freshPage, mounted, openPublicLink, shotPath, type MatrixCase } from "../smoke-fixture/index.mts";

const repo = process.env.REPO!, out = process.env.OUT!;
assert(repo && out); mkdirSync(out, { recursive: true });
const base = process.env.SKEW_BASE ?? "b6a1c683897e604a83078d58fde7a73bb3ab3435";
const oldDictionary = execFileSync("git", ["show", `${base}:src/ui/shared/app-i18n.js`], { cwd: repo, encoding: "utf8", maxBuffer: 1024 * 1024 });
assert(!oldDictionary.includes("needs_reason_hub_unavailable"), "actual pre-Hub-hold dictionary");
const hubStringsBase = process.env.HUB_STRINGS_BASE ?? "19e8e6c879c933edac83211e5642d45cdb789f92";
const oldHubStrings = execFileSync("git", ["show", `${hubStringsBase}:src/ui/hub-strings.js`], { cwd: repo, encoding: "utf8", maxBuffer: 1024 * 1024 });
assert(!oldHubStrings.includes("provider_engine-unavailable"), "actual Hub strings before setup guidance");
const fx = await bootFixture({ port: Number(process.env.HP ?? 48632), instances: 2, classic: false });
const { deriveNeedsYou } = await import(repo + "/src/needs-you.ts");
const { HUB_PROVIDER_SETUP_REASONS: reasons } = await import(repo + "/src/hub/execution/provider-setup.ts");
const { setLocale, t } = await import(repo + "/src/locale.ts");
const since = Date.now();
const ordinary = { id: "delivery:ordinary", type: "delivery", instance: fx.instances[0].name, reason: "delivery_failed", detail: "Ordinary attention remains available", since };
let reason = reasons[0];
// S5 owns runtime -> FleetManager projection. This inert fixture starts at its bounded, localized Needs-you input.
fx.fm.needsYouItems = () => [...deriveNeedsYou({ prompts: [], instances: [], deliveries: [], ownerOf: () => undefined,
  hubHolds: [{ side: "member", code: "hub-provider-unavailable", detail: t(`hub.provider.${reason}`), since }] }), ordinary];
const link = await openPublicLink(fx), rows: unknown[] = [];
try {
  for (const device of ["desk", "phone"] as const) for (const lang of ["en", "zh-TW"] as const) for (const skew of ["fresh", "stale-shell", "retained-hub-strings"] as const) {
    setLocale(lang);
    const c: MatrixCase = { device, lang, theme: device === "phone" ? "dark" : "light" };
    let seenOld = 0, oldHubLoads = 0, freshHubLoads = 0, cardLoads = 0, upgraded = false;
    const p = await freshPage(fx, c, { account: "operator", reducedMotion: true, beforeNavigate: async (ctx: any) => {
      if (skew === "stale-shell") await ctx.route("**/assets/app-i18n.js", async (route: any) => { seenOld++; await route.fulfill({ body: oldDictionary, contentType: "text/javascript" }); });
      if (skew === "retained-hub-strings") {
        await ctx.route("**/ui/js/hub-strings.js", async (route: any) => {
          if (!upgraded) { oldHubLoads++; await route.fulfill({ body: oldHubStrings, contentType: "text/javascript" }); }
          else { freshHubLoads++; await route.continue(); }
        });
        await ctx.route("**/ui/js/settings-hub.js", async (route: any) => { cardLoads++; await route.continue(); });
      }
      await ctx.route("**/settings/access", async (route: any) => {
        const response = await route.fetch(); await route.fulfill({ response, body: (await response.text()).replace(/<body([^>]*)>/, '<body$1 data-hub="member">') });
      });
    } });
    try {
      await mounted(p.page);
      if (skew === "retained-hub-strings") {
        await p.page.evaluate(`(async () => {
          await import("/ui/js/hub-switcher.js");
          window.__retainedHubStrings = await import("/ui/js/hub-strings.js");
          if (window.__retainedHubStrings.hw("provider_engine-unavailable") !== "hub.provider_engine-unavailable") throw Error("old Hub copy was not retained");
        })()`);
        assert(oldHubLoads > 0 && cardLoads === 0, "the switcher retained actual old words before the new Settings card loaded");
        upgraded = true;
      }
      await p.page.evaluate(`(async () => {
        document.body.dataset.hub = "member";
        const m = await import("/ui/js/hub-client.js");
        const s = m.createStubClient({ agents: () => [{ name: "sample" }] });
        await s.connect({ address: "https://hub.example.test", code: "ABCD-EFGH" }); s.control.approve({ name: "Sample Hub" });
        const reasons = ${JSON.stringify([...reasons, "PRIVATE-KEY <script>"])};
        s.exposures = async () => reasons.map((reason, n) => ({ agent: "sample-" + n, display: "Sample " + n, state: "withdrawn", revision: 0, exposureId: null, policy: null, enforceable: false, reason, choices: { dataViews: [], tools: [] }, pending: null }));
        m.setHubClient(s);
        history.pushState(null, "", "/settings/access"); dispatchEvent(new PopStateEvent("popstate"));
      })()`);
      await p.page.waitForSelector(".hub-provider-guidance");
      const guidance = p.page.locator(".hub-provider-guidance");
      assert.equal(await guidance.count(), reasons.length);
      for (let n = 0; n < reasons.length; n++) assert.equal(await guidance.nth(n).textContent(), t(`hub.provider.${reasons[n]}`));
      assert.equal(await p.page.locator('.hub-exposure input[role="switch"]:disabled').count(), reasons.length + 1);
      assert.equal(await p.page.locator('.hub-exposure input[role="switch"]:enabled').count(), 0);
      assert(!(await p.page.locator(".hub-exposures").textContent()).includes("PRIVATE-KEY"));
      assert(await p.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await p.page.locator(".hub-exposure").first().scrollIntoViewIfNeeded();
      await p.page.screenshot({ path: shotPath("hub-provider-setup", `${device}-${lang}-${skew}`, "exposures") });
      for (reason of reasons) {
        fx.fm.emitSseEvent("needs", { items: fx.fm.needsYouItems() });
        await p.page.evaluate(`(() => { history.pushState(null, "", "/ui/needs"); dispatchEvent(new PopStateEvent("popstate")); })()`);
        await p.page.waitForSelector(".n-item");
        // Fresh poll through the real handlers, then the actual lazy Needs-you renderer.
        try { await p.page.waitForFunction((text: string) => document.querySelector(".p-needs")?.textContent?.includes(text), t(`hub.provider.${reason}`), { timeout: 12_000 }); }
        catch (error) {
          writeFileSync(join(out, "failure.json"), JSON.stringify({ device, lang, skew, reason, expected: t(`hub.provider.${reason}`),
            text: await p.page.locator("body").textContent(), poll: await p.page.evaluate(async () => (await fetch("/ui/poll")).json()), errors: p.errors }, null, 2));
          throw error;
        }
        const card = p.page.locator(".n-item").filter({ hasText: t(`hub.provider.${reason}`) });
        assert.equal(await card.count(), 1); assert.equal(await card.locator("button, input, select, form").count(), 0);
        assert((await card.textContent()).includes(lang === "en" ? "Hub not running" : "Hub 未在執行"));
        assert(!(await p.page.locator(".p-needs").textContent()).includes("needs_reason_hub_"));
        assert(await p.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        await p.page.screenshot({ path: shotPath("hub-provider-setup", `${device}-${lang}-${skew}`, reason) });
      }
      if (skew === "stale-shell") assert(seenOld > 0);
      if (skew === "retained-hub-strings") {
        assert(cardLoads > 0 && freshHubLoads === 0, "new lazy card reuses cached old Hub words without refetch");
        assert(await p.page.evaluate(`(async () => (await import("/ui/js/hub-strings.js")) === window.__retainedHubStrings)()`));
      }
      assert.deepEqual(p.errors, []); rows.push({ device, lang, skew, reasons: reasons.length, ok: true, seenOld, oldHubLoads, freshHubLoads, cardLoads });
      console.log(`PASS ${device} ${lang} ${skew}`);
    } finally { await p.ctx.close(); }
  }
  for (const lang of ["en", "zh-TW"] as const) {
    const p = await link.publicPage({ device: "phone", lang, theme: "dark" }, { path: "/ui/needs", reducedMotion: true });
    try {
      await p.page.waitForSelector(".n-item");
      const poll = await p.page.evaluate(async () => (await fetch("/ui/poll")).json());
      assert.deepEqual(poll.needs.map((item: any) => item.id), [ordinary.id]);
      const text = await p.page.locator(".p-needs").textContent(); assert(!text.includes("credentialRef")); assert(!text.includes("provider"));
      assert.deepEqual(p.errors, []); rows.push({ public: true, lang, ok: true });
    } finally { await p.ctx.close(); }
  }
  writeFileSync(join(out, "setup-guidance.json"), JSON.stringify({ base, hubStringsBase, rows, limits: "Inert metadata inputs; real local/public HTTP and lazy renderers. No engine, CLI, model login or S5 startup composition qualification." }, null, 2));
} finally { await link.close(); await fx.close(); }
