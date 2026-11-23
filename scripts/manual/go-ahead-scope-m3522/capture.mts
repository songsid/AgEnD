/**
 * M-3522: real Chromium on the real fleet web server (smoke fixture: scratch home, synthetic roster, no fleet start,
 * no CLI, account or model). Captures, for the user's look:
 * - Settings → the agent → Basic info: the "Owner and routine operations" box (filled with a sample text);
 * - Details → Overview: the "Loaded every session" card, with a 51 KB CLAUDE.md (over 50 KB) on a Claude Code agent and
 *   a 40 KB AGENTS.md (over Codex's 32 KiB cut-off) on a Codex agent; a third agent stays under every limit.
 * Env: REPO=<checkout> PW_DIR=<dir with playwright-core> OUT=<output dir> [MATRIX=desk-light-en,phone-dark-zh-TW]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { bootFixture, matrix, caseName } from "../smoke-fixture/index.mts";

const out = resolve(process.env.OUT!);
mkdirSync(out, { recursive: true });
const roster = [
  { name: "build-server", displayName: "Build server", backend: "claude-code" as const, description: "Keeps the build server running.", status: "running" as const },
  { name: "release-notes", displayName: "Release notes", backend: "codex" as const, description: "Drafts release notes.", status: "running" as const },
];
const fx = await bootFixture({ port: 0, roster, classic: false, host: true });
const OPS = "The owner of the build server talks to you here.\nRestarting its services, reading their logs and running status queries are routine.";
const OPS_ZH = "建置伺服器的擁有者會在這裡跟你說話。\n重新啟動它的服務、讀記錄、查狀態都是日常操作。";
const checks: Array<Record<string, unknown>> = [];
try {
  // Every fixture agent works in the scratch home (smoke-fixture writes one working_directory for all).
  writeFileSync(join(fx.dir, "CLAUDE.md"), "# Notes\n" + "x".repeat(51 * 1024));
  writeFileSync(join(fx.dir, "AGENTS.md"), "# Notes\n" + "y".repeat(40 * 1024));
  fx.fm.saveFleetConfig([{ path: ["instances", "build-server", "systemPrompt"], value: "Be terse. Report what you did, then the next step." }]);
  for (const c of matrix(process.env.MATRIX ?? "desk-light-en,phone-dark-zh-TW")) {
    // Saved the way Settings saves it (fleet.yaml), so the form reads it back.
    fx.fm.saveFleetConfig([{ path: ["instances", "build-server", "operations"], value: c.lang === "zh-TW" ? OPS_ZH : OPS }]);
    for (const [view, path, sel] of [
      ["settings", "/ui/fleet/agent/build-server?cat=basic", "#ag-ops"],
      ["details-claude", "/ui/fleet/agent/build-server?cat=overview", "[data-instruction-files]"],
      ["details-codex", "/ui/fleet/agent/release-notes?cat=overview", "[data-instruction-files]"],
    ] as const) {
      const { ctx, page } = await fx.page(c, { path });
      const errors: string[] = [];
      page.on("pageerror", (e: any) => errors.push(String(e).slice(0, 200)));
      try {
        const target = page.locator(sel).first();
        await target.waitFor({ timeout: 15000 });
        await page.evaluate(() => document.fonts.ready);
        await target.scrollIntoViewIfNeeded();
        const card = view === "settings" ? page.locator(".field", { has: page.locator("#ag-ops") }).locator("xpath=ancestor::*[contains(@class,'card')][1]") : target;
        const info = await page.evaluate((s: string) => {
          const el = document.querySelector(s) as HTMLElement | null;
          return {
            overflow: document.documentElement.scrollWidth > innerWidth + 1,
            value: el && "value" in el ? (el as HTMLTextAreaElement).value.length : null,
            warning: document.querySelector("[data-instruction-warning]")?.textContent ?? null,
            over: [...document.querySelectorAll("[data-instruction-files] [data-over]")].length,
          };
        }, sel);
        if (info.overflow || errors.length) throw Error(JSON.stringify({ view, c, info, errors }));
        await card.screenshot({ path: join(out, `${view}-card-${caseName(c)}.png`) });
        await page.screenshot({ path: join(out, `${view}-page-${caseName(c)}.png`), fullPage: false });
        checks.push({ view, case: caseName(c), ...info, pageErrors: errors.length });
      } finally { await ctx.close(); }
    }
  }
  writeFileSync(join(out, "checks.json"), JSON.stringify(checks, null, 2));
  console.log(JSON.stringify(checks, null, 1));
} finally { await fx.close(); }
