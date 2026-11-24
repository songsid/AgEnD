// M-3648 captures (scratch): Cozy, a stuck agent at the Help desk and an idle one; zero real names. LABEL=before|after.
// Records every speech bubble line drawn on the Office canvas (its words and place), then shoots the office.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const REPO = process.env.REPO!, LABEL = process.env.LABEL ?? "after", OUT = join(process.env.OUT!, LABEL);
mkdirSync(OUT, { recursive: true });
const { bootFixture, mounted } = await import(join(REPO, "scripts/manual/smoke-fixture/index.mts"));
const fx = await bootFixture({ port: 0, oldPort: Number(process.env.HP ?? 49049), classic: false, roster: [
  { name: "general", general: true, backend: "claude-code", displayName: "General", status: "running" },
  { name: "example-agent", backend: "codex", displayName: "Example helper", status: "running" },
] });
fx.fm.getInstanceExecutionState = (name: string) => (name === "example-agent" ? "stuck" : "idle");
const WANTED = ["Hmm, stuck?", "Still thinking…", "嗯，卡住了？", "還在想…"];
const RECORD = `(() => { const w = window; w.__said = []; const orig = CanvasRenderingContext2D.prototype.fillText; const want = new Set(${JSON.stringify(WANTED)});
  CanvasRenderingContext2D.prototype.fillText = function (s, x, y) { if (this.canvas && this.canvas.classList && this.canvas.classList.contains("oo-canvas") && want.has(String(s))) {
    const m = this.getTransform(), r = this.canvas.getBoundingClientRect(), d = w.devicePixelRatio || 1; w.__said.push({ s: String(s), x: Math.round(r.left + (m.a * x + m.e) / d), y: Math.round(r.top + (m.d * y + m.f) / d), at: performance.now() }); }
    return orig.apply(this, arguments); }; })();`;
const report: any = { label: LABEL, cases: {} };
const cases = [{ device: "desk", theme: "light", lang: "en" }, { device: "desk", theme: "dark", lang: "zh-TW" }, { device: "phone", theme: "dark", lang: "zh-TW" }, { device: "phone", theme: "light", lang: "en" }] as const;
try {
  for (const c of cases) {
    const key = `${c.device}-${c.theme}-${c.lang}`, errors: string[] = [];
    const { ctx, page, csp } = await fx.page(c as any, { path: "/ui/fleet/org", storage: { agend_org_mode: "office", agend_org_office_skin: "cozy" } });
    await page.addInitScript({ content: RECORD });
    page.on("pageerror", (e: Error) => errors.push(String(e)));
    await mounted(page, 30000);
    await page.goto(`${fx.base}/ui/fleet/org`);
    await page.locator(".oo-canvas").waitFor(); await page.waitForTimeout(9000);   // a few bubble rounds
    await page.screenshot({ path: join(OUT, `${key}-office.png`) });
    // The view as it opens (desk: as wide as the panel; phone: at Fit), saved before a zoomed sample clears the record.
    const said = await page.evaluate(() => ((window as any).__said as any[]));
    report.cases[key] = { errors, csp: [] as string[], bubbleLines: said.length, lastBubble: said.length ? said[said.length - 1] : null, distinct: [...new Set(said.map((x: any) => x.s))] };
    if (c.device === "phone") {
      // Zoomed in on the helper, to read it: its card's "Find in office" (200 %), then the card closed.
      const desk = page.locator('.oo-desk[data-name="example-agent"]');
      await desk.focus(); await page.keyboard.press("Enter");
      await page.locator(".oo-card").waitFor(); await page.locator(".oo-card-find").click(); await page.waitForTimeout(800);
      if (await page.locator(".oo-card").count()) { await page.locator(".oo-card-close").click(); }
      // No focus left on the person's accessible desk (its tooltip would sit over the bubble).
      await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur?.(); }); await page.mouse.move(5, 5);
      await page.evaluate(() => { (window as any).__said = []; });
      await page.waitForTimeout(9000);
      await page.screenshot({ path: join(OUT, `${key}-zoomed.png`) });
      const z = await page.evaluate(() => ({ said: ((window as any).__said as any[]).map((x) => x.s), pct: document.querySelector(".oo-zoom-pct")?.textContent }));
      report.cases[`${key}-zoomed`] = { zoom: z.pct, bubbleLines: z.said.length, distinct: [...new Set(z.said)] };
    }
    report.cases[key].csp = await csp();
    await ctx.close();
  }
} finally { await fx.close(); }
writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
