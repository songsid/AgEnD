/** Real browser, real web handlers, scratch fixture only: never start a fleet, CLI or tunnel.
 * REPO=$PWD PW_DIR=<playwright-core prefix> OUT=<artifacts> npx tsx scripts/manual/hub-execution/needs-skew.mts
 * SKEW_BASE is the pre-S4 source ref (default is the S1 checkpoint carried by #3107).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { bootFixture, freshPage, openPublicLink, mounted, shotPath, type MatrixCase } from "../smoke-fixture/index.mts";

const repo = process.env.REPO!;
const base = process.env.SKEW_BASE ?? "b6a1c683897e604a83078d58fde7a73bb3ab3435";
const old = (path: string) => execFileSync("git", ["show", `${base}:${path}`], { cwd: repo, encoding: "utf8", maxBuffer: 1024 * 1024 });
const oldDictionary = old("src/ui/shared/app-i18n.js"), oldPanel = old("src/ui/panel-needs.js");
assert(!oldDictionary.includes("needs_reason_hub_proposal")); assert(!oldPanel.includes("item.hubProposal"));
const fx = await bootFixture({ port: Number(process.env.HP ?? 48572), instances: 2, classic: false });
const { deriveNeedsYou } = await import(repo + "/src/needs-you.ts");
const agent = fx.instances[0].name;
const proposal = { id: "proposal", kind: "proposal", agent, messageId: "question", exposureId: "exposure", since: Date.now(),
  proposal: { action: "delete sample item <script>", arguments: '{"amount":1,"target":"S4-PRIVATE-ARGUMENTS"}',
    argumentsDigest: "a".repeat(64), consequences: "S4-PRIVATE-CONSEQUENCES: the selected item would be removed." } };
const hubItems = deriveNeedsYou({ prompts: [], instances: [], deliveries: [], hubExecution: [proposal,
  { id: "hold", kind: "hold", agent, messageId: "held", exposureId: "exposure", since: Date.now() }], ownerOf: () => undefined });
const ordinary = { id: "delivery:ordinary", type: "delivery", instance: agent, reason: "delivery_failed", detail: "Ordinary attention remains usable", since: Date.now(), deliveryId: "ordinary" };
fx.fm.needsYouItems = () => [...hubItems, ordinary];
let acked = 0;
fx.fm.acknowledgeNeedsItem = (id: string) => { assert.equal(id, ordinary.id); acked++; return { status: 200, message: "Acknowledged." }; };
const link = await openPublicLink(fx);
const rows: unknown[] = [];
try {
  for (const device of ["desk", "phone"] as const) for (const lang of ["en", "zh-TW"] as const) {
    const c: MatrixCase = { device, lang, theme: device === "phone" ? "dark" : "light" };
    for (const skew of ["fresh", "stale-shell", "old-panel"] as const) {
      let upgrading = skew === "fresh";
      const seen = { dictionary: 0, panel: 0 };
      const p = await freshPage(fx, c, { account: "operator", reducedMotion: true, beforeNavigate: async (ctx: any) => {
        await ctx.addInitScript(() => { localStorage.setItem("agend_tour_done", "1"); localStorage.setItem("agend_firstrun_dismissed", "1"); });
        await ctx.route("**/assets/app-i18n.js", async (route: any) => {
          if (!upgrading) { seen.dictionary++; await route.fulfill({ body: oldDictionary, contentType: "text/javascript" }); }
          else await route.continue();
        });
        await ctx.route("**/ui/js/panel-needs.js", async (route: any) => {
          if (skew === "old-panel" && !upgrading) { seen.panel++; await route.fulfill({ body: oldPanel, contentType: "text/javascript" }); }
          else await route.continue();
        });
      } });
      try {
        await mounted(p.page);
        if (skew === "stale-shell") upgrading = true; // The old module remains in the browser's module map.
        await p.page.evaluate(async () => { const a = [...document.querySelectorAll<HTMLAnchorElement>('a[href="/ui/needs"]')].find(a => a.getBoundingClientRect().width); a!.click(); });
        await p.page.waitForSelector(".n-item");
        if (skew === "old-panel") {
          assert(seen.dictionary > 0 && seen.panel > 0, "actual old modules loaded");
          assert.equal(await p.page.locator(".n-item button").count(), 1, "old renderer cannot turn a Hub item into a decision");
          assert.equal(await p.page.locator(".n-item pre").count(), 0, "old panel does not pretend to render new proposal detail");
          await p.page.screenshot({ path: shotPath("hub-needs-skew", `${device}-${lang}-${skew}`, "before-refresh") });
          upgrading = true; await p.page.reload(); await p.page.waitForSelector(".n-item pre");
        }
        if (skew === "stale-shell") assert(seen.dictionary > 0, "pre-upgrade dictionary actually loaded");
        const card = p.page.locator(".n-item").filter({ hasText: proposal.proposal.action });
        assert.equal(await card.count(), 1);
        assert.equal(await card.locator("pre").textContent(), proposal.proposal.arguments);
        assert((await card.textContent()).includes(proposal.proposal.consequences));
        assert.equal(await card.locator("button, input, textarea, select, form").count(), 0);
        assert.equal(await card.locator("script").count(), 0, "proposal action remains literal text");
        const text = await p.page.locator(".p-needs").textContent();
        assert(!text.includes("app.needs_reason_hub_"));
        assert(text.includes(lang === "en" ? "Hub action proposed: review locally" : "Hub 提議操作：請在本機檢視"));
        assert(text.includes(lang === "en" ? "Hub work held: review locally" : "Hub 工作已暫停：請在本機檢視"));
        const count = acked;
        await p.page.locator(".n-item").filter({ hasText: ordinary.detail }).locator("button").click();
        await p.page.waitForFunction(() => [...document.querySelectorAll(".n-item button")].some(b => b.hasAttribute("disabled")));
        assert.equal(acked, count + 1);
        if (device === "phone") assert(await p.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        assert.deepEqual(p.errors, []);
        await p.page.screenshot({ path: shotPath("hub-needs-skew", `${device}-${lang}-${skew}`, "exact-proposal") });
        rows.push({ device, lang, skew, ok: true, seen, oldPanelRequiresRefreshForNewDetail: skew === "old-panel" });
        console.log(`PASS ${device} ${lang} ${skew}`);
      } finally { await p.ctx.close(); }
    }
    const p = await link.publicPage(c, { path: "/ui/needs", reducedMotion: true });
    try {
      await p.page.waitForSelector(".n-item");
      const response = await p.page.evaluate(async () => (await fetch("/ui/poll")).json());
      assert.equal(response.needs.length, 1); assert.equal(response.needs[0].id, ordinary.id);
      assert(!JSON.stringify(response).includes("S4-PRIVATE"));
      assert(!(await p.page.locator("body").textContent()).includes("S4-PRIVATE"));
      assert.equal(await p.page.locator(".n-item pre").count(), 0);
      assert.deepEqual(p.errors, []);
      rows.push({ device, lang, public: true, ok: true }); console.log(`PASS ${device} ${lang} public-withholding`);
    } finally { await p.ctx.close(); }
  }
  assert.equal(rows.length, 16);
  const out = process.env.OUT ?? ".artifacts/hub-needs-skew"; mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "result.json"), JSON.stringify({ base, rows }, null, 2));
  console.log("PASS 16 browser cases");
} finally { await link.close(); await fx.close(); }
