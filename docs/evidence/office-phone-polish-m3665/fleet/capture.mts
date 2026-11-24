// M-3665 captures (scratch): the Fleet Office with working, idle, paused, stopped (offline) and stuck agents; zero real
// names. Every built-in style at desk en (calls still show); Cozy on desk + phone, en/zh, light/dark. Records the stuck
// lines and the name tags drawn on the canvas, and every zone chip's box (whole, in view). LABEL=before|after.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const REPO = process.env.REPO!, LABEL = process.env.LABEL ?? "after", OUT = join(process.env.OUT!, LABEL);
mkdirSync(OUT, { recursive: true });
const { bootFixture, mounted } = await import(join(REPO, "scripts/manual/smoke-fixture/index.mts"));
const ROSTER = [
  { name: "general", general: true, backend: "claude-code", displayName: "General", status: "running" },
  { name: "agent-work", backend: "codex", displayName: "Worker", status: "running" },
  { name: "agent-paused", backend: "codex", displayName: "Paused one", status: "paused" },
  { name: "agent-off", backend: "kiro-cli", displayName: "Offline one", status: "stopped" },
  { name: "agent-stuck", backend: "claude-code", displayName: "Stuck one", status: "running" },
];
const fx = await bootFixture({ port: 0, oldPort: Number(process.env.HP ?? 49051), classic: false, roster: ROSTER });
fx.fm.getInstanceExecutionState = (n: string) => (n === "agent-stuck" ? "stuck" : n === "agent-work" ? "working" : "idle");
const NAMES = ROSTER.map((r) => r.displayName);
const CALLS = ["Hmm, stuck?", "Still thinking…", "嗯，卡住了？", "還在想…"];
const RECORD = `(() => { const w = window; w.__t = []; const orig = CanvasRenderingContext2D.prototype.fillText;
  CanvasRenderingContext2D.prototype.fillText = function (s, x, y) { if (this.canvas && this.canvas.classList && this.canvas.classList.contains("oo-canvas")) {
    const m = this.getTransform(), d = w.devicePixelRatio || 1, px = parseFloat((/([0-9.]+)px/.exec(this.font) || [0, 0])[1]); w.__t.push({ s: String(s), css: Math.round(px * Math.hypot(m.a, m.b) / d * 10) / 10 }); }
    return orig.apply(this, arguments); }; })();`;
const report: any = { label: LABEL, cases: {} };
const STYLES = ["cozy", "studio", "pixel", "guild", "school"];   // the Fleet office's styles ("studio-large" is a Hub room's)
const cases: any[] = [
  ...STYLES.map((style) => ({ device: "desk", theme: "light", lang: "en", style })),
  { device: "desk", theme: "dark", lang: "zh-TW", style: "cozy" },
  { device: "phone", theme: "dark", lang: "zh-TW", style: "cozy" },
  { device: "phone", theme: "light", lang: "en", style: "cozy" },
];
try {
  for (const c of cases) {
    const key = `${c.device}-${c.theme}-${c.lang}-${c.style}`, errors: string[] = [];
    // The style as the host keeps it (an admin's page draws the host's style; Prism #4423: the browser key alone was not it).
    const set = fx.fm.officeStore.setAutoSkin(c.style); if (!set.ok) throw new Error(`setAutoSkin ${c.style}: ${JSON.stringify(set)}`);
    const { ctx, page, csp } = await fx.page(c, { path: "/ui/fleet/org", storage: { agend_org_mode: "office", agend_org_office_skin: c.style } });
    await page.addInitScript({ content: RECORD });
    page.on("pageerror", (e: Error) => errors.push(String(e)));
    await mounted(page, 30000);
    await page.goto(`${fx.base}/ui/fleet/org`);
    await page.locator(".oo-canvas").waitFor(); await page.waitForTimeout(8000);
    await page.screenshot({ path: join(OUT, `${key}.png`) });
    const m = await page.evaluate((a: any) => {
      const t = (window as any).__t as any[], last = t.slice(-400);
      const tags = last.filter((x) => a.names.includes(x.s));
      const chips = [...document.querySelectorAll(".oo-zone-pills .btn")].map((b) => { const r = (b as HTMLElement).getBoundingClientRect(), box = (b.closest(".oo-zone-pills") as HTMLElement).getBoundingClientRect();
        return { t: (b.textContent || "").trim(), whole: (b as HTMLElement).scrollWidth <= (b as HTMLElement).clientWidth + 1, inView: r.left >= box.left - 0.5 && r.right <= box.right + 0.5 && r.right <= innerWidth + 0.5 && r.left >= -0.5 }; });
      return { calls: t.filter((x) => a.calls.includes(x.s)).length, tagNames: [...new Set(tags.map((x) => x.s))], tagCss: tags.length ? Math.min(...tags.map((x) => x.css)) : null,
        zoom: document.querySelector(".oo-zoom-pct")?.textContent ?? null, chips,
        people: [...document.querySelectorAll(".oo-desks .oo-desk")].map((b) => { const r = (b as HTMLElement).getBoundingClientRect(); return { t: (b.textContent || "").trim(), h: Math.round(r.height), w: Math.round(r.width), shown: r.width > 2 && r.height > 2, inView: r.left >= -0.5 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5 }; }),
        tagsOff: document.querySelector(".oo")?.hasAttribute("data-tags-off") ?? null };
    }, { names: NAMES, calls: CALLS });
    // The style actually drawn: Display options' Style (desk), else the phone sheet's.
    let shown: string | null = null;
    if (c.device === "desk") { await page.locator(".oo-display-btn").click(); shown = await page.locator(".oo-display-pop .oo-style").inputValue(); await page.keyboard.press("Escape"); }
    else { await page.locator(".oo-more-btn").click(); await page.locator(".oo-sheet .oo-style").waitFor(); shown = await page.locator(".oo-sheet .oo-style").inputValue(); await page.locator(".oo-sheet .dlg-x").click(); }
    await page.waitForTimeout(300);
    let fs: any = null;
    if (c.device === "phone") {
      // Fullscreen at the same zoom (Prism #4423 P1): the names stay readable there too.
      await page.locator(".oo-fs").click(); await page.waitForTimeout(1200);
      fs = await page.evaluate(() => {
        const oo = document.querySelector(".oo") as HTMLElement, row = document.querySelector(".oo-desks") as HTMLElement, rr = row.getBoundingClientRect();
        const pills = document.querySelector(".oo-zone-pills") as HTMLElement | null, pr = pills ? pills.getBoundingClientRect() : null;
        const chips = [...row.querySelectorAll(".oo-desk")].map((b) => (b as HTMLElement).getBoundingClientRect());
        return { fs: oo.className, tagsOff: oo.hasAttribute("data-tags-off"), row: { w: Math.round(rr.width), h: Math.round(rr.height), clip: getComputedStyle(row).clip },
          chipH: chips.length ? Math.round(Math.min(...chips.map((r) => r.height))) : null, pills: pr ? { top: Math.round(pr.top), bottom: Math.round(pr.bottom), shown: pr.height > 2 } : null,
          overlap: !!pr && pr.height > 2 && rr.bottom > pr.top && rr.top < pr.bottom && rr.right > pr.left && rr.left < pr.right };
      });
      await page.screenshot({ path: join(OUT, `${key}-fullscreen.png`) });
    }
    report.cases[key] = { errors, csp: await csp(), style: shown, ...m, fs };
    await ctx.close();
  }
} finally { await fx.close(); }
writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
console.log("done");
