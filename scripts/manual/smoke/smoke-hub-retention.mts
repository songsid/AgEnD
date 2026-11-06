// Host Settings renderer only: inert retention DTOs, the existing isolated HTTP fixture, no Hub/LDAP/CLI/host service.
// REPO=<checkout> PW_DIR=<dir with playwright-core> OUT=<artifacts> SKEW=<base src/ui> npx tsx <this file>
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, caseName, matrix, shotPath } from "../smoke-fixture/index.mts";

const fx = await bootFixture({ port: Number(process.env.HP ?? 48983), classic: false, instances: 1 });
const rows: any[] = [];
try {
  for (const c of matrix(process.env.MATRIX ?? "desk-light-en,desk-dark-zh-TW,phone-dark-zh-TW,phone-light-en")) {
    for (const skew of ["fresh", "stale-shell", "retained-strings", "old-panel", "public-marker"]) {
      if (skew !== "fresh" && !process.env.SKEW) throw Error("SKEW must name the actual base src/ui files");
      const { ctx, page } = await fx.page(c);
      const errors: string[] = [], writes: any[] = [], oldLoads: string[] = []; let reads = 0;
      page.on("pageerror", (e: any) => errors.push(String(e)));
      const files = skew === "stale-shell" ? ["app.js", "app-shell.js", "app-store.js", "app-i18n.js", "app.css", "instance-nav.js"]
        : skew === "retained-strings" ? ["settings-strings.js"] : skew === "old-panel" ? ["panel-settings.js", "settings-strings.js"] : [];
      for (const file of files) await page.route(`**/${file}*`, (r: any) => {
        oldLoads.push(file); return r.fulfill({ status: 200, contentType: file.endsWith(".css") ? "text/css" : "text/javascript",
          body: readFileSync(join(process.env.SKEW!, file), "utf8") });
      });
      await page.route("**/api/settings/fleet/raw", async (r: any) => {
        const reply = await r.fetch(); const raw = await reply.json();
        await r.fulfill({ response: reply, json: { ...raw, hub: { hubId: "11111111-1111-4111-8111-111111111111" } } });
      });
      await page.route("**/api/settings/hub/retention", (r: any) => {
        const write = r.request().method() === "PUT";
        if (write) writes.push(r.request().postDataJSON()); else reads++;
        return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true,
          policy: { contentDays: write ? 12 : 7, eventDays: 30, revision: write ? 4 : 3 } }) });
      });
      if (skew === "public-marker") await page.route("**/settings/access", async (r: any) => {
        const response = await r.fetch(); const body = (await response.text()).replace(/<body([^>]*)>/, '<body$1 data-public-link="1">');
        await r.fulfill({ response, body });
      });
      await page.goto(fx.base + "/settings/access");
      await page.waitForSelector(".s-access-session", { timeout: 20000 });
      if (skew === "old-panel" || skew === "public-marker") {
        await page.waitForTimeout(250);
        rows.push({ case: caseName(c), skew, ok: errors.length === 0 && (skew === "public-marker" ? reads === 0 && writes.length === 0 : oldLoads.includes("panel-settings.js")) && await page.locator(".hub-retention").count() === 0, errors, oldLoads, reads });
      } else {
        await page.waitForSelector(".hub-retention input");
        await page.locator(".hub-retention input").first().fill("12");
        await page.locator(".hub-retention button").click();
        await page.waitForFunction(() => document.querySelector(".hub-retention [role=status]")?.textContent?.includes("saved")
          || document.querySelector(".hub-retention [role=status]")?.textContent?.includes("已儲存"));
        const text = await page.locator(".hub-retention").innerText();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
        const expected = { contentDays: 12, eventDays: 30, revision: 3 };
        const ok = !errors.length && !overflow && !text.includes("hubRetention.") && writes.length === 1 && JSON.stringify(writes[0]) === JSON.stringify(expected)
          && (skew === "fresh" || oldLoads.length > 0) && text.includes(c.lang === "en" ? "Hub record retention" : "Hub 紀錄保留期間");
        await page.screenshot({ path: shotPath("hub-retention", c, skew) });
        rows.push({ case: caseName(c), skew, ok, errors, overflow, writes, oldLoads });
      }
      await ctx.close();
    }
  }
  writeFileSync(join(process.env.OUT!, "hub-retention.json"), JSON.stringify({ rows, limits: "Renderer/DTO browser checks; no Hub, directory, CLI, native service or live pilot." }, null, 2));
  console.log(JSON.stringify({ cases: rows.length, pass: rows.filter(r => r.ok).length, failed: rows.filter(r => !r.ok) }));
  if (!rows.length || rows.some(r => !r.ok)) process.exitCode = 1;
} finally { await fx.close(); }
