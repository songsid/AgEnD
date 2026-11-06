// Loopback web renderer and inert build DTOs only. No fleet start, CLI, directory or pilot deployment.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, caseName, matrix, shotPath } from "../smoke-fixture/index.mts";
const fx = await bootFixture({ port: Number(process.env.HP ?? 49023), classic: false, instances: 1 });
const rows: any[] = [], sha = "a".repeat(40);
try {
  for (const c of matrix(process.env.MATRIX ?? "desk-light-en,desk-dark-zh-TW,phone-dark-zh-TW,phone-light-en")) {
    for (const skew of ["fresh", "stale-shell", "retained-strings", "old-panel", "old-api", "release"]) {
      if (!["fresh", "old-api", "release"].includes(skew) && !process.env.SKEW) throw Error("SKEW must name actual base src/ui files");
      const { ctx, page, csp } = await fx.page(c);
      const errors: string[] = [], oldLoads: string[] = [];
      let apiBound = false;
      page.on("pageerror", (e: Error) => errors.push(e.message));
      page.on("console", (m: any) => { if (m.type() === "error" && /Content Security Policy|Refused to (?:apply|load|execute)/i.test(m.text())) errors.push(m.text()); });
      const files = skew === "stale-shell" ? ["app.js", "app-shell.js", "app-store.js", "app-i18n.js", "app.css", "instance-nav.js"]
        : skew === "retained-strings" ? ["settings-strings.js"] : skew === "old-panel" ? ["panel-settings.js", "settings-strings.js"] : [];
      for (const file of files) await page.route(`**/${file}*`, (r: any) => {
        oldLoads.push(file); return r.fulfill({ status: 200, contentType: file.endsWith(".css") ? "text/css" : "text/javascript", body: readFileSync(join(process.env.SKEW!, file), "utf8") });
      });
      await page.route("**/api/fleet", async (r: any) => {
        const response = await r.fetch(), body = await response.json();
        apiBound = typeof body.version === "string" && body.build?.version === body.version && Object.hasOwn(body.build, "source");
        const version = skew === "release" ? "2.3.5" : "1.22.0";
        const source = { format: 1, commit: sha, ref: skew === "release" ? "v2.3.5" : "release/2.3.5-alpha", channel: skew === "release" ? "release" : "alpha", modified: skew === "release" ? false : null, from: skew === "release" ? "git" : "archive" };
        return r.fulfill({ response, body: JSON.stringify({ ...body, version, build: skew === "old-api" ? undefined : { version, source } }) });
      });
      await page.goto(fx.base + "/settings/agents");
      const pill = page.locator(".pill.ver"); await pill.waitFor();
      await page.evaluate(() => document.fonts.ready);
      const text = await pill.innerText(), href = await pill.getAttribute("href"), title = await pill.getAttribute("title"), accessible = await pill.getAttribute("aria-label");
      const layout = await page.evaluate(() => {
        const pill = document.querySelector(".pill.ver")!, r = pill.getBoundingClientRect();
        const contentRight = r.right - parseFloat(getComputedStyle(pill).paddingRight);
        let shaVisible = false;
        const walker = document.createTreeWalker(pill, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const node = walker.currentNode, at = node.textContent?.indexOf("aaaaaaa") ?? -1;
          if (at < 0) continue;
          const range = document.createRange(); range.setStart(node, at); range.setEnd(node, at + 7);
          const text = range.getBoundingClientRect();
          if (text.width > 0 && text.right <= contentRight + 0.5 && text.left >= r.left - 0.5 && pill.scrollWidth <= pill.clientWidth) shaVisible = true;
        }
        return { overflow: document.documentElement.scrollWidth > innerWidth + 1 || r.right > innerWidth || r.left < 0, shaVisible, pillWidth: r.width };
      });
      const { overflow, shaVisible } = layout;
      const violations = await csp(), fallback = skew === "old-panel" || skew === "old-api" || skew === "release";
      const ok = apiBound && !errors.length && !violations.length && !overflow
        && !text.includes("installedBuild.") && (fallback ? text === (skew === "release" ? "v2.3.5" : "v1.22.0")
          : shaVisible && text.includes(c.device === "phone" ? "α·aaaaaaa" : "2.3.5-alpha · aaaaaaaaaaaa")
            && title?.includes(c.lang === "en" ? "changes unknown" : "變更狀態不明") && title?.includes("1.22.0") && accessible === title && href?.endsWith(sha))
        && (!files.length || oldLoads.length === files.length);
      await page.locator(".panel-head").screenshot({ path: shotPath("build-provenance", c, skew) });
      rows.push({ case: caseName(c), skew, ok, apiBound, text, href, title, accessible, overflow, shaVisible, pillWidth: layout.pillWidth, errors, violations, oldLoads }); await ctx.close();
    }
  }
  writeFileSync(join(process.env.OUT!, "build-provenance.json"), JSON.stringify({ rows, limits: "Chromium renderer/cache and additive API shape only; no running fleet, directory, CLI login, native service or pilot." }, null, 2));
  console.log(JSON.stringify({ cases: rows.length, pass: rows.filter(r => r.ok).length, failed: rows.filter(r => !r.ok) }));
  if (!rows.length || rows.some(r => !r.ok)) process.exitCode = 1;
} finally { await fx.close(); }
