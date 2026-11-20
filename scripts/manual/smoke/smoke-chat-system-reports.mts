// M-3425: real app + real signed-in command route, synthetic collectors only.
// No Fleet start, backend probe, model turn or external request.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, matrix, caseName } from "../smoke-fixture/index.mts";

const out = process.env.OUT ?? ".artifacts/m3425/captures";
mkdirSync(out, { recursive: true });
const scale = process.env.SCALE === "80";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48960), instances: scale ? 60 : 5, classic: false });
const results: any[] = [];
try {
  const fm = fx.fm;
  if (scale) {
    const roster = Array.from({ length: 60 }, (_, i) => ({
      name: i % 10 === 0 ? "example-worker-" + (i + 1) + "-long-name-for-release-planning-and-documentation" : "example-worker-" + (i + 1),
      backend: "codex" as const, general: i === 0,
    }));
    fx.instances.splice(0, fx.instances.length, ...roster);
    fm.fleetConfig.instances = Object.fromEntries(roster.map(r => [r.name, {
      backend: r.backend, working_directory: fx.dir, ...(r.general ? { general_topic: true } : {}),
    }]));
    const rooms = Array.from({ length: 20 }, (_, i) => ({
      instanceName: i % 4 === 0 ? "example-room-" + (i + 1) + "-long-name-for-release-planning-and-documentation" : "example-room-" + (i + 1),
      channelId: "example-channel-" + (i + 1), adapterId: "discord",
      name: "Example room " + (i + 1), backend: "codex",
    }));
    writeFileSync(join(fx.dir, "classicBot.yaml"), JSON.stringify({ channels: Object.fromEntries(rooms.map((r, i) => ["room" + i, r])) }));
    const { ClassicChannelManager } = await import(process.env.REPO + "/src/classic-channel-manager.ts");
    fm.classicChannels = new ClassicChannelManager(fx.dir, fm.logger);
    const names = [...fx.instances.map(i => i.name), ...rooms.map(r => r.instanceName)];
    if (names.length !== 80 || fm.classicChannels.getAll().length !== 20) throw new Error("scale roster");
    const paused = new Set(names.filter((_, i) => i % 2 === 1));
    fm.getInstanceStatus = (n: string) => paused.has(n) ? "paused" : "running";
    fm.lifecycle.isPaused = (n: string) => paused.has(n);
  }
  fm.getSysInfo = () => ({
    uptime_seconds: 7380, memory_mb: { rss: 128, heapUsed: 64, heapTotal: 96 },
    running_count: scale ? 40 : 4, paused_count: scale ? 40 : 1, fleet_mem_mb: 1024, system_mem_gb: { used: 4, total: 16 },
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
      const start = Date.now();
      const response = page.waitForResponse((r: any) => r.url().endsWith("/ui/command") && r.request().method() === "POST");
      await page.locator("#cmd-" + command).click();
      await page.locator("#sendBtn").click();
      const r = await response;
      if (r.status() !== 200) throw new Error(command + ": " + r.status());
      const data = await r.json();
      if (command === "status" && (data.report.columns.length !== 6 || data.report.columns.some((s: string) => /Cost|花費/.test(s)))) throw new Error("status cost column");
      await page.locator(".cmd-report-" + command).waitFor();
      await page.evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))");
      const renderedMs = Date.now() - start;
      if (c.device === "phone") {
        const send = await page.locator("#sendBtn").boundingBox();
        const tabs = await page.locator(".tabs").boundingBox();
        if (!send || (tabs && send.y + send.height > tabs.y + 1)) throw new Error("report hides composer");
      }
      const geometry = await page.locator(".cmd-report-body").evaluate((el: any) => ({
        clientHeight: el.clientHeight, scrollHeight: el.scrollHeight, viewportHeights: +(el.scrollHeight / el.clientHeight).toFixed(1),
        rows: el.querySelectorAll("tbody tr").length,
      }));
      if (scale && command === "status" && geometry.rows !== 80) throw new Error("missing scale rows");
      await page.screenshot({ path: join(out, caseName(c) + "-" + command + ".png") });
      const overflow = await page.evaluate('document.documentElement.scrollWidth > innerWidth');
      const reportOverflow = await page.locator(".cmd-report-body").evaluate((el: any) => el.scrollWidth > el.clientWidth + 1);
      if (overflow || reportOverflow || errors.length || (await csp()).length) throw new Error("report layout or page error");
      if (c.device === "phone") {
        const scroll = await page.locator(".cmd-report-body").evaluate((el: any) => {
          el.scrollTop = el.scrollHeight;
          return { scrollTop: el.scrollTop, max: el.scrollHeight - el.clientHeight };
        });
        if (scroll.max > 1 && scroll.scrollTop < scroll.max - 1) throw new Error("report cannot scroll to its end");
        await page.screenshot({ path: join(out, caseName(c) + "-" + command + "-end.png") });
      }
      if (scale) {
        if (command === "status") {
          await page.locator(".cmd-report input").fill("example-room-20");
          await page.waitForFunction('document.querySelectorAll(".cmd-report tbody tr").length === 1');
          await page.screenshot({ path: join(out, caseName(c) + "-" + command + "-filtered.png") });
        }
        await page.locator("[data-report-expand]").click();
        await page.locator("dialog[open]").waitFor();
        if (command === "status") {
          if (await page.locator("dialog tbody tr").count() !== 1) throw new Error("expanded filter lost");
          await page.locator("dialog input").fill("");
          await page.waitForFunction('document.querySelectorAll("dialog tbody tr").length === 80');
        }
        const modalOverflow = await page.locator("dialog").evaluate((el: any) => el.scrollWidth > el.clientWidth + 1);
        if (modalOverflow) throw new Error("expanded overflow");
        await page.screenshot({ path: join(out, caseName(c) + "-" + command + "-expanded.png") });
        await page.locator("dialog .cmd-report-body").evaluate((el: any) => { el.scrollTop = el.scrollHeight; });
        const close = await page.locator(".dlg-x").boundingBox();
        if (!close || close.y < 0 || close.y + close.height > page.viewportSize().height) throw new Error("report hides dialog close");
        if (c.device === "phone" && (close.width < 44 || close.height < 44)) throw new Error("report close touch target");
        await page.screenshot({ path: join(out, caseName(c) + "-" + command + "-expanded-end.png") });
        await page.locator(".dlg-x").click();
        await page.locator("dialog").waitFor({ state: "detached" });
      }
      results.push({ case: caseName(c), command, status: r.status(), columns: data.report.columns.length, renderedMs, ...geometry, overflow, reportOverflow });
      await page.locator(".cmd-head .icon-btn").click();
    }
    await ctx.close();
  }
  writeFileSync(join(out, "checks.json"), JSON.stringify(results, null, 2) + "\n");
} finally { await fx.close(); }
