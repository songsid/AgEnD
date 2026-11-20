// M-3425: real app + real signed-in command route, synthetic collectors only.
// No Fleet start, backend probe, model turn or external request.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, matrix, caseName } from "../smoke-fixture/index.mts";

const out = process.env.OUT ?? ".artifacts/m3425/captures";
mkdirSync(out, { recursive: true });
const fx = await bootFixture({ port: Number(process.env.HP ?? 48960), instances: 5, classic: false });
const results: any[] = [];
try {
  const fm = fx.fm;
  fm.getSysInfo = () => ({
    uptime_seconds: 7380, memory_mb: { rss: 128, heapUsed: 64, heapTotal: 96 },
    running_count: 4, paused_count: 1, fleet_mem_mb: 1024, system_mem_gb: { used: 4, total: 16 },
  });
  fm.getBackendCliVersionSnapshot = () => ({
    "claude-code": { version: "example-version" }, codex: { version: "example-version" },
  });
  fm.refreshBackendCliVersions = () => { throw new Error("a report must not probe"); };
  fm.getInstanceExecutionState = () => "idle";
  fm.modelDisplayForInstance = () => "example-model";
  fm.resolveInstanceEffort = () => ({ effort: "medium" });
  const name = fx.instances.find(i => !i.general)!.name;
  for (const c of matrix("desk-light-en,desk-dark-zh-TW,phone-light-en,phone-dark-zh-TW")) {
    const { ctx, page, csp } = await fx.page(c, { path: "/ui/chat/" + encodeURIComponent(name) });
    const errors: string[] = [];
    page.on("pageerror", (e: Error) => errors.push(e.message));
    await page.locator("#msgIn").waitFor();
    for (const command of ["sysinfo", "status"]) {
      await page.locator("#msgIn").fill("/" + command);
      await page.locator("#cmd-" + command).waitFor();
      await page.screenshot({ path: join(out, caseName(c) + "-" + command + "-palette.png") });
      const response = page.waitForResponse((r: any) => r.url().endsWith("/ui/command") && r.request().method() === "POST");
      await page.locator("#cmd-" + command).click();
      await page.locator("#sendBtn").click();
      const r = await response;
      if (r.status() !== 200) throw new Error(command + ": " + r.status());
      const data = await r.json();
      if (command === "status" && (data.report.columns.length !== 6 || data.report.columns.some((s: string) => /Cost|花費/.test(s)))) throw new Error("status cost column");
      await page.locator(".cmd-report-" + command).waitFor();
      await page.screenshot({ path: join(out, caseName(c) + "-" + command + ".png") });
      const overflow = await page.evaluate('document.documentElement.scrollWidth > innerWidth');
      const reportOverflow = await page.locator(".cmd-report").evaluate((el: any) => el.scrollWidth > el.clientWidth + 1);
      if (overflow || reportOverflow || errors.length || (await csp()).length) throw new Error("report layout or page error");
      if (c.device === "phone") {
        const scroll = await page.locator(".cmd-report").evaluate((el: any) => {
          el.scrollTop = el.scrollHeight;
          return { scrollTop: el.scrollTop, max: el.scrollHeight - el.clientHeight };
        });
        if (scroll.max > 1 && scroll.scrollTop < scroll.max - 1) throw new Error("report cannot scroll to its end");
        await page.screenshot({ path: join(out, caseName(c) + "-" + command + "-end.png") });
      }
      results.push({ case: caseName(c), command, status: r.status(), columns: data.report.columns.length, overflow, reportOverflow });
      await page.locator(".cmd-head .icon-btn").click();
    }
    await ctx.close();
  }
  writeFileSync(join(out, "checks.json"), JSON.stringify(results, null, 2) + "\n");
} finally { await fx.close(); }
