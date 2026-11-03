// v2.3.4-beta.4 P1 (the user, hmsg-985db235): after scrolling up, a Claude agent's View text kept shrinking, a little every
// second. On the shared fixture (web server only: no fleet, no CLI) over REAL tmux panes on the fixture's private socket:
// a Claude-like full-screen pane (the alternate screen, every row drawn, redrawn each second), a Codex-like pane printing a
// line every 100 ms, and the same live pane at a larger text size (a screen taller than its box).
// Per case, the View's text size (the .v-pre font-size) and the terminal box's height are sampled every second:
//  - for 10 s after opening (following);
//  - then after the person scrolls up in it (the wheel on the desk, a touch drag on the phone): 30 s more.
// Judged: the size settles (no change over the last 25 s of each stretch, and never more than 2 changes after the
// first second); the box height is stable too; no page error. Pictures at 0 s, after the scroll, and at the end.
//   PW_DIR=… REPO=<checkout> OUT=<dir> PW_DPR=2 FONTCONFIG_FILE=/etc/fonts/fonts.conf [SECONDS=30] \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-view-shrink.mts
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, freshPage, mounted, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-view-shrink";
const AFTER_S = Number(process.env.SECONDS ?? 30);
const fx = await bootFixture({ port: Number(process.env.HP ?? 48880), classic: false, instances: 4 });
const fm = fx.fm;
const { getTmuxSocketName } = await import(process.env.REPO + "/src/paths.ts");
const { getTmuxSession } = await import(process.env.REPO + "/src/config.ts");
const socket = getTmuxSocketName(), session = getTmuxSession();
if (!socket) throw new Error("the fixture's home must give a private tmux socket");
const tmux = (...args: string[]) => execFileSync("tmux", ["-L", socket, ...args], { encoding: "utf8" });
const names = Object.keys(fm.fleetConfig.instances).filter((n: string) => !fm.fleetConfig.instances[n].general_topic);
const live = names.find((n: string) => fm.fleetConfig.instances[n].backend !== "claude-code")!;
const full = names.find((n: string) => fm.fleetConfig.instances[n].backend === "claude-code")!;
if (!live || !full) throw new Error("the fixture needs a Claude Code agent and another");
const liveScript = join(fx.dir, "live.py"), fullScript = join(fx.dir, "full.py");
writeFileSync(liveScript, "import sys,time\nn=0\nwhile True:\n  n+=1\n  sys.stdout.write('\\x1b[3%dmline %d\\x1b[0m the agent says something useful here\\n' % (n % 6 + 1, n)); sys.stdout.flush(); time.sleep(0.1)\n");
// Like Claude Code: the alternate screen, every row drawn (a transcript, a box, a status line), redrawn each second.
writeFileSync(fullScript, [
  "import sys,time,shutil", "sys.stdout.write('\\x1b[?1049h'); n=0", "while True:", "  n+=1; c,r=shutil.get_terminal_size()",
  "  rows=['\\x1b[38;5;%dm● claude says line %d of turn %d\\x1b[0m %s' % (100+i%50, i, n, 'x'*(c-40)) for i in range(r-4)]",
  "  rows+=['╭'+'─'*(c-2)+'╮','│ > '+' '*(c-5)+'│','╰'+'─'*(c-2)+'╯','  ? for shortcuts  %s' % time.strftime('%T')]",
  "  sys.stdout.write('\\x1b[H'+'\\r\\n'.join(s[:c] for s in rows)); sys.stdout.flush(); time.sleep(1)", ""].join("\n"));
tmux("new-session", "-d", "-s", session, "-x", "120", "-y", "40", "-n", "live", `python3 ${liveScript}`);
tmux("new-window", "-t", session, "-n", "full", `python3 ${fullScript}`);
for (const [name, win] of [[live, "live"], [full, "full"]] as const) {
  const wid = tmux("display-message", "-p", "-t", `${session}:${win}`, "#{window_id}").trim();
  mkdirSync(join(fx.dir, "instances", name), { recursive: true });
  writeFileSync(join(fx.dir, "instances", name, "window-id"), wid);
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const results: Array<Record<string, unknown>> = [];
let failedN = 0;

const CASES = [
  { id: "desk-claude", c: { device: "desk", theme: "dark", lang: "en" }, agent: full, size: null },
  { id: "desk-codex", c: { device: "desk", theme: "light", lang: "en" }, agent: live, size: null },
  { id: "desk-tall", c: { device: "desk", theme: "dark", lang: "en" }, agent: live, size: "l" },
  { id: "phone-claude", c: { device: "phone", theme: "dark", lang: "zh-TW" }, agent: full, size: null },
  { id: "phone-codex", c: { device: "phone", theme: "light", lang: "zh-TW" }, agent: live, size: null },
] as const;
const only = process.env.CASES ? new Set(process.env.CASES.split(",")) : null;

for (const k of CASES) {
  if (only && !only.has(k.id)) continue;
  const failed: string[] = [];
  const p = await freshPage(fx, k.c as any, { account: "operator" });
  const page = p.page, errors: string[] = [];
  // SKEW=<dir>: a tab opened before an upgrade — its stylesheet and the View's words as the page first loaded them
  // (<dir>/app.css, <dir>/view-strings.js), the View's code (loaded on first use) from the new install.
  if (process.env.SKEW) for (const f of ["app.css", "view-strings.js"]) {
    const body = (await import("node:fs")).readFileSync(join(process.env.SKEW, f), "utf8");
    // Only the page's first read of each is the old file: a later read (the View reading it again) is the server's own.
    let first = true;
    await page.route(`**/assets/${f}*`, (r: any) => { if (!first) return r.continue(); first = false; return r.fulfill({ status: 200, contentType: f.endsWith(".css") ? "text/css" : "text/javascript", body }); });
  }
  page.on("pageerror", (e: any) => errors.push(String(e)));
  const sample = () => page.evaluate(() => {
    const pre = document.querySelector(".v-pre") as HTMLElement | null, t = document.querySelector(".v-term") as HTMLElement | null;
    const box = document.querySelector(".v-term-box");
    return { px: pre ? parseFloat(getComputedStyle(pre).fontSize) : null, h: t ? t.clientHeight : null, w: t ? t.clientWidth : null,
      bottom: !!t && t.scrollHeight - t.scrollTop - t.clientHeight <= 2, scrolls: !!t && t.scrollHeight > t.clientHeight + 2,
      reading: !!t && t.className.includes("is-reading"), raw: (box?.textContent || "").match(/\bview\.[A-Za-z]+/)?.[0] ?? null };
  }) as Promise<{ px: number | null; h: number | null; w: number | null; bottom: boolean; scrolls: boolean; reading: boolean; raw: string | null }>;
  const watch = async (secs: number) => { const out = []; for (let i = 0; i < secs; i++) { out.push(await sample()); await sleep(1000); } return out; };
  const judge = (label: string, s: Array<{ px: number | null; h: number | null }>) => {
    const px = s.map((x) => x.px), h = s.map((x) => x.h);
    const changes = px.slice(1).filter((v, i) => v !== px[i]).length;
    const tail = px.slice(Math.max(1, px.length - 25));
    const settled = tail.every((v) => v === tail[0]);
    const hTail = h.slice(Math.max(1, h.length - 25));
    if (!settled || changes > 2) failed.push(`${label}: the text size keeps changing (${px.join(" → ")})`);
    if (!hTail.every((v) => v === hTail[0])) failed.push(`${label}: the box height keeps changing (${h.join(" → ")})`);
    return { px: [...new Set(px)], changes, h: [...new Set(h)] };
  };
  try {
    await mounted(page, 30000);
    await page.goto(`${p.base}/view/${encodeURIComponent(k.agent)}`);
    await page.waitForSelector(".v-pre", { timeout: 20000 });
    await page.waitForFunction(() => (document.querySelector(".v-pre")?.textContent || "").length > 100, null, { timeout: 15000 });
    if (k.size) {
      // A screen taller than its box: a box its height limits, and the larger Aa as a person picks it (the header's button).
      await page.setViewportSize({ width: 1366, height: 600 });
      for (let i = 0; i < 4; i++) {
        const tall = await page.evaluate(() => { const t = document.querySelector(".v-term")!; return t.scrollHeight - t.clientHeight; });
        if (tall > 40) break;
        await page.locator(".hd-text").first().click(); await sleep(600);
      }
      const tall = await page.evaluate(() => { const t = document.querySelector(".v-term")!; return t.scrollHeight - t.clientHeight; });
      if (tall <= 40) failed.push(`the screen never got taller than its box (${tall})`);
    }
    await page.screenshot({ path: shotPath(SMOKE, k.id, "open") });
    const opened = await watch(10);
    const open = judge("following", opened);
    const last = opened.at(-1)!;
    if (!last.bottom) failed.push(`following: not at the live bottom (${JSON.stringify(last)})`);
    if (opened.some((x) => x.raw)) failed.push(`a raw key shows: ${opened.find((x) => x.raw)!.raw}`);
    // The person scrolls up in it.
    const box = (await page.locator(".v-term").boundingBox())!;
    if (k.c.device === "desk") { await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.wheel(0, -400); }
    else {
      const cdp = await p.ctx.newCDPSession(page), x = box.x + box.width / 2, y = box.y + 60;
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      for (let i = 1; i <= 6; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + i * 20 }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    }
    await sleep(1500);
    await page.screenshot({ path: shotPath(SMOKE, k.id, "scrolled") });
    const afterS = await watch(AFTER_S);
    const after = judge("after scrolling up", afterS);
    if (afterS.some((x) => x.raw)) failed.push(`a raw key shows after scrolling: ${afterS.find((x) => x.raw)!.raw}`);
    await page.screenshot({ path: shotPath(SMOKE, k.id, "end") });
    // A CLI with scrollback: reading earlier output now; Jump to latest follows the live bottom again.
    let jumped: unknown = null;
    if (k.agent === live) {
      const rd = await sample();
      if (!rd.reading) failed.push(`scrolling up did not read earlier output (${JSON.stringify(rd)})`);
      await page.locator(".v-term-latest").click({ timeout: 5000 }).catch((e: any) => failed.push(`no Jump to latest: ${String(e).slice(0, 80)}`));
      await sleep(2000);
      const j = await sample(); jumped = j;
      if (j.reading || !j.bottom) failed.push(`Jump to latest did not follow the bottom (${JSON.stringify(j)})`);
      await page.screenshot({ path: shotPath(SMOKE, k.id, "jumped") });
    }
    if (errors.length) failed.push(`page errors: ${errors.slice(0, 2).join(" | ")}`);
    results.push({ name: k.id, ok: !failed.length, failed, open, after, following: last, jumped });
  } catch (e) { failed.push(String(e).slice(0, 200)); results.push({ name: k.id, ok: false, failed }); }
  if (failed.length) failedN++;
  console.log(`${failed.length ? "FAIL" : "ok  "} ${k.id} ${JSON.stringify(results.at(-1)).slice(0, 900)}`);
  await p.ctx.close();
}
writeFileSync(join(process.env.OUT ?? "/tmp/smoke-out", SMOKE, "result.json"), JSON.stringify({ failed: failedN, results }, null, 2));
try { tmux("kill-session", "-t", session); } catch { /* gone */ }
await fx.close();
process.exit(failedN ? 1 : 0);
