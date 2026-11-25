// M-3723 capture: the ClassicBot defaults note (newRoomsRestricted) in Settings → Chat, where it names the room's
// Settings → Permissions path. Desk light EN and dark zh-TW. REPO=<checkout> OUT=<dir> LABEL=before|after.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const REPO = process.env.REPO!, LABEL = process.env.LABEL ?? "after", OUT = join(process.env.OUT!, LABEL);
mkdirSync(OUT, { recursive: true });
const { bootFixture, mounted } = await import(join(REPO, "scripts/manual/smoke-fixture/index.mts"));
const fx = await bootFixture({ port: 0, oldPort: Number(process.env.HP ?? 49057), instances: 2 });
const report: any = { label: LABEL, cases: {} };
try {
  for (const c of [{ device: "desk", theme: "light", lang: "en" }, { device: "desk", theme: "dark", lang: "zh-TW" }] as const) {
    const key = `${c.device}-${c.theme}-${c.lang}`, errors: string[] = [];
    const { ctx, page, csp } = await fx.page(c as any, { path: "/settings/chat" });
    page.on("pageerror", (e: Error) => errors.push(String(e)));
    await mounted(page, 30000);
    const sum = page.locator("details.s-classic-defaults > summary");
    await sum.waitFor({ timeout: 20000 }); await sum.click(); await page.waitForTimeout(800);
    const note = page.locator(".contact-new-rooms");
    await note.scrollIntoViewIfNeeded(); await page.waitForTimeout(300);
    await note.screenshot({ path: join(OUT, `${key}-note.png`) });
    await page.locator(".s-classic-defaults-card").screenshot({ path: join(OUT, `${key}-card.png`) });
    report.cases[key] = { errors, csp: await csp(), text: (await note.textContent())?.trim() };
    await ctx.close();
  }
} finally { await fx.close(); }
writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
console.log("done");
