// M-2909: a ClassicBot room's AI account in a real browser on the shared smoke fixture — before (the base's modules,
// served in place of this checkout's: also an open old tab's SKEW) and after, in zh-TW and en.
//   1. the room's settings → Runtime & model: the Account picker (after), none (before);
//   2. Settings → Agents → AI accounts → 「移入 Agent」 on a Claude profile: the room listed under ClassicBot rooms (after).
// Isolated like smoke-accounts-move-3335: scratch HOME and AGEND_HOME, a private mock `claude` (version and auth status
// only), guard binaries for tmux/codex/kiro; no fleet start, no real CLI, no provider, loopback only.
//   REPO=$PWD PW_DIR=<playwright-core dir> OUT=<dir> [BASE_REF=origin/release/2.3.5-alpha] FONTCONFIG_FILE=/etc/fonts/fonts.conf \
//   npx tsx scripts/manual/smoke/smoke-classic-room-account-2909.mts
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const REPO = process.env.REPO ?? process.cwd();
const OUT = join(process.env.OUT ?? "/tmp/smoke-out", "classic-room-account-2909");
const BASE_REF = process.env.BASE_REF ?? "origin/release/2.3.5-alpha";
mkdirSync(OUT, { recursive: true });
const owned = mkdtempSync(join(tmpdir(), "agend-2909-smoke-")), home = join(owned, "home"), bin = join(owned, "bin");
for (const p of [home, bin, join(home, ".claude"), join(home, ".codex"), join(owned, "tmux"), join(home, ".local", "share")]) mkdirSync(p, { recursive: true });
// The scratch HOME hides the user's own fonts (the CJK one is there): link them in, read-only use.
const realFonts = join(process.env.HOME ?? "", ".local", "share", "fonts");
if (existsSync(realFonts)) symlinkSync(realFonts, join(home, ".local", "share", "fonts"));
Object.assign(process.env, { HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), CODEX_HOME: join(home, ".codex"), TMUX_TMPDIR: join(owned, "tmux") });
writeFileSync(join(bin, "package.json"), '{"type":"commonjs"}\n');
writeFileSync(join(bin, "claude"), `#!${process.execPath}
const fs=require('fs'),path=require('path');const a=process.argv.slice(2),root=process.env.CLAUDE_CONFIG_DIR;
if(a.includes('--version')){console.log('2.1.322 (Claude Code)');process.exit(0)}
if(a[0]==='auth'&&a[1]==='status'){let c;try{c=JSON.parse(fs.readFileSync(path.join(root,'.credentials.json'),'utf8'))}catch{}const on=!!c?.claudeAiOauth?.accessToken;console.log(JSON.stringify({loggedIn:on,authMethod:on?'oauth_token':'none'}));process.exit(on?0:1)}
process.exit(97);
`);
const guard = `#!${process.execPath}\nprocess.exit(97);\n`;
for (const n of ["tmux", "codex", "kiro-cli", "agend-private-tmux"]) writeFileSync(join(bin, n), guard);
for (const n of ["claude", "tmux", "codex", "kiro-cli", "agend-private-tmux"]) chmodSync(join(bin, n), 0o755);
process.env.PATH = [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(":");
process.env.AGEND_TMUX_BIN = join(bin, "agend-private-tmux");

const { bootFixture } = await import("../smoke-fixture/index.mts");
const { CLASSIC_ROOMS } = await import("../smoke-fixture/data.mts");
const fx = await bootFixture({ port: Number(process.env.GATE_PORT ?? 49270), instances: 6 });
// Two Claude profiles, signed in (fake tokens): "work" and "team".
const seed = (name: string) => {
  const root = join(fx.dir, "credential-profiles", "claude-code", name); mkdirSync(root, { recursive: true, mode: 0o700 });
  writeFileSync(join(root, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "fixture-" + "c".repeat(40), refreshToken: "fixture-" + "r".repeat(40), expiresAt: Date.now() + 3600e3, subscriptionType: "max" } }));
  writeFileSync(join(root, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "00000000-0000-4000-8000-00000000000" + name.length } }));
};
seed("work"); seed("team");
const room = CLASSIC_ROOMS.find((r: any) => r.backend === "claude-code" && !r.instanceName.includes("bot"))!;
const old = (path: string) => execFileSync("git", ["-C", REPO, "show", `${BASE_REF}:${path}`], { encoding: "utf8", maxBuffer: 16 << 20 });
const result: Record<string, unknown> = { base: BASE_REF, room: room.instanceName };
const fail: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => { result[name] = ok ? "PASS" : { FAIL: detail ?? true }; if (!ok) fail.push(name); };
try {
  for (const lang of ["zh-TW", "en"] as const) {
    for (const leg of ["before", "after"] as const) {
      const c = { device: "desk", theme: "light", lang } as any;
      const { ctx, page, csp } = await fx.page(c, { path: "/settings/chat" });
      await page.addInitScript({ content: "window.__name = (f) => f;" });
      const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
      if (leg === "before") for (const [url, file] of [["/ui/js/settings-dialogs.js", "src/ui/settings-dialogs.js"], ["/ui/js/accounts-view.js", "src/ui/accounts-view.js"]]) {
        const body = old(file);
        await page.route(`**${url}`, (route: any) => route.fulfill({ status: 200, contentType: "application/javascript", body }));
      }
      // 1. The room's settings (Settings → Chat & connections → the room → Settings): Runtime & model.
      await page.goto(`${fx.base}/settings/chat`);
      await page.waitForSelector(".s-classic-row", { timeout: 20000 });
      await page.locator(".s-classic-row", { hasText: room.name }).first().locator(".s-actions button").first().click();
      await page.waitForSelector("#cl-be", { timeout: 20000 }); await page.waitForTimeout(1500);
      const picker = await page.$("#cl-account");
      const options = picker ? await page.$$eval("#cl-account option", (os: any[]) => os.map((o) => o.value)) : null;
      await page.screenshot({ path: join(OUT, `${lang}-${leg}-1-room-runtime.png`), fullPage: true });
      check(`${lang}:${leg}:room-picker`, leg === "after" ? !!picker && JSON.stringify(options) === JSON.stringify(["", "team", "work"]) : !picker, { options });
      if (leg === "after" && picker) {
        await page.selectOption("#cl-account", "work"); await page.waitForTimeout(500);
        await page.screenshot({ path: join(OUT, `${lang}-after-1b-room-picked.png`), fullPage: true });
      }
      // 2. Settings → Agents → AI accounts → 「移入 Agent」 on "work".
      await page.goto(`${fx.base}/settings/agents`);
      await page.waitForSelector(".s-ai-accounts summary", { timeout: 20000 });
      await page.click(".s-ai-accounts summary"); await page.waitForTimeout(2500);
      const row = page.locator('.s-account-card[data-backend="claude-code"] .s-account-row[data-account="work"]');
      await row.locator(".s-actions button", { hasText: lang === "zh-TW" ? "移入 Agent" : "Move agents here" }).first().click();
      await page.waitForTimeout(800);
      const head = await page.$(".s-account-move-head");
      const roomsListed = await page.$$eval(".s-account-move-rooms li span", (s: any[]) => s.map((x) => x.textContent));
      await page.screenshot({ path: join(OUT, `${lang}-${leg}-2-move-dialog.png`) });
      check(`${lang}:${leg}:move-rooms`, leg === "after" ? !!head && roomsListed.length >= 1 : !head, { roomsListed });
      const cspNow = await csp();
      check(`${lang}:${leg}:no-errors`, errs.length === 0 && cspNow.length === 0, { errs, csp: cspNow });
      await ctx.close();
    }
  }
} catch (e) {
  fail.push("error"); result.error = String((e as Error).stack ?? e).slice(0, 1500);
} finally {
  writeFileSync(join(OUT, "result.json"), JSON.stringify(result, null, 1));
  for (const f of fail) console.log(`FAIL ${f}: ${JSON.stringify((result[f] as any)?.FAIL ?? result.error ?? "").slice(0, 600)}`);
  console.log(fail.length ? `M-2909 smoke FAILED (${fail.length}) — ${OUT}` : `M-2909 smoke passed (${Object.keys(result).length - 2} checks) — ${OUT}`);
  await fx.close();
  process.exit(fail.length ? 1 : 0);
}
