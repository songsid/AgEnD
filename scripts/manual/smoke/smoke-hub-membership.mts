// Owner Settings only: inert membership/pairing DTOs; no Hub/LDAP/CLI/host service or real fleet start.
// REPO=<checkout> PW_DIR=<playwright-core> CHROME=<owned browser> OUT=<artifacts> SKEW=<actual base src/ui> npx tsx <this file>
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, caseName, matrix, shotPath } from "../smoke-fixture/index.mts";
const fx = await bootFixture({ port: Number(process.env.HP ?? 49013), classic: false, instances: 1 });
const rows: any[] = [];
try {
  for (const c of matrix(process.env.MATRIX ?? "desk-light-en,desk-dark-zh-TW,phone-dark-zh-TW,phone-light-en")) {
    for (const skew of ["fresh-off", "stale-shell", "retained-strings", "old-panel", "public-marker", "live-member"]) {
      if (skew !== "fresh-off" && skew !== "live-member" && !process.env.SKEW) throw Error("SKEW must name actual base src/ui files");
      const { ctx, page, csp } = await fx.page(c);
      const errors: string[] = [], writes: any[] = [], oldLoads: string[] = [], hubLoads: string[] = [];
      let enabled = skew === "live-member", reads = 0, memberReads = 0;
      page.on("pageerror", (e: any) => errors.push(String(e)));
      page.on("request", (r: any) => { if (/\/(hub-client|settings-hub|hub-strings)\.js(?:\?|$)/.test(r.url())) hubLoads.push(r.url().split("/").pop()); });
      page.on("console", (m: any) => { if (m.type() === "error" && /Content Security Policy|Refused to (?:apply|load|execute)/i.test(m.text())) errors.push(m.text()); });
      const files = skew === "stale-shell" ? ["app.js", "app-shell.js", "app-store.js", "app-i18n.js", "app.css", "instance-nav.js"]
        : skew === "retained-strings" ? ["settings-strings.js", "hub-strings.js"] : skew === "old-panel" ? ["panel-settings.js", "settings-strings.js"] : [];
      for (const file of files) await page.route(`**/${file}*`, (r: any) => {
        oldLoads.push(file); return r.fulfill({ status: 200, contentType: file.endsWith(".css") ? "text/css" : "text/javascript", body: readFileSync(join(process.env.SKEW!, file), "utf8") });
      });
      await page.route("**/api/settings/hub/membership", (r: any) => {
        if (r.request().method() === "PUT") { const body = r.request().postDataJSON(); writes.push(body); enabled = body.enabled; } else reads++;
        return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, enabled }) });
      });
      await page.route("**/api/hub/member/**", (r: any) => {
        memberReads++;
        if (r.request().method() !== "GET") throw Error("smoke never pairs or publishes");
        return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, pairing: { state: "unpaired" }, exposures: [], hubs: [] }) });
      });
      if (skew === "public-marker" || skew === "live-member") await page.route("**/settings/access", async (r: any) => {
        const response = await r.fetch(), mark = skew === "public-marker" ? 'data-public-link="1"' : 'data-hub="member"';
        const body = (await response.text()).replace(/<body([^>]*)>/, `<body$1 ${mark}>`);
        await r.fulfill({ response, body });
      });
      await page.goto(fx.base + "/settings/access"); await page.waitForSelector(".s-access-session", { timeout: 20000 });
      if (skew === "old-panel" || skew === "public-marker") {
        await page.waitForTimeout(250);
        rows.push({ case: caseName(c), skew, ok: !errors.length && !(await csp()).length && reads === 0 && writes.length === 0
          && await page.locator(".hub-membership-settings").count() === 0 && (skew !== "old-panel" || oldLoads.includes("panel-settings.js")), errors, oldLoads, reads, writes });
      } else {
        const card = page.locator(".hub-membership-settings"), toggle = card.locator('input[role="switch"]');
        await toggle.waitFor(); await page.waitForFunction(() => !(document.querySelector('.hub-membership-settings input') as HTMLInputElement)?.disabled);
        if (skew === "live-member") {
          await page.waitForSelector("#hubAddress");
          await card.screenshot({ path: shotPath("hub-membership", c, "live-member-on") });
          await toggle.click();
        } else {
          if (skew === "fresh-off") await card.screenshot({ path: shotPath("hub-membership", c, "initial-off") });
          await toggle.click();
        }
        for (let n = 0; n < 100 && reads < 2; n++) await page.waitForTimeout(25);
        await page.waitForFunction((wanted: boolean) => {
          const input = document.querySelector('.hub-membership-settings input') as HTMLInputElement;
          return input && !input.disabled && input.checked === wanted;
        }, skew !== "live-member");
        const checked = await toggle.isChecked(), text = await card.innerText(), violations = await csp();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
        const ok = !errors.length && !violations.length && !overflow && !text.includes("hubMembership.") && checked === (skew !== "live-member")
          && JSON.stringify(writes) === JSON.stringify([{ enabled: skew !== "live-member" }]) && reads === 2
          && text.includes(c.lang === "en" ? "Reload page" : "重新整理頁面") && await page.locator("#hubAddress").count() === 0
          && (skew === "live-member" ? memberReads > 0 : memberReads === 0 && hubLoads.length === 0)
          && (skew === "fresh-off" || skew === "live-member" || oldLoads.length > 0);
        await card.screenshot({ path: shotPath("hub-membership", c, skew) });
        rows.push({ case: caseName(c), skew, ok, errors, violations, overflow, oldLoads, hubLoads, writes, reads, memberReads });
      }
      await ctx.close();
    }
  }
  writeFileSync(join(process.env.OUT!, "hub-membership.json"), JSON.stringify({ rows, limits: "Renderer/DTO cache/browser checks only; no pairing/publishing, Hub, directory, CLI, native service or live pilot." }, null, 2));
  console.log(JSON.stringify({ cases: rows.length, pass: rows.filter(r => r.ok).length, failed: rows.filter(r => !r.ok) }));
  if (!rows.length || rows.some(r => !r.ok)) process.exitCode = 1;
} finally { await fx.close(); }
