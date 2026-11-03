// M-2267 (the user, hmsg-435f6df6; constraint hmsg-b8a170c0): the web View's terminal scrolls back, in a real browser,
// on the product's own web server (the shared fixture) over a REAL tmux pane on the fixture's private socket — no fleet,
// no CLI: the first agent's window runs a script printing a numbered, coloured line every 100 ms (live output), the
// second's draws in the alternate screen like a full-screen CLI.
// Cases desk-light-en (wheel), phone-dark-zh-TW (touch drag). Judged:
//  - following: the newest lines, "Earlier output" offered;
//  - scrolling up during live output: the scrollback (line 1 is there), reading; for 3 s the text and the place do not
//    move (no yank) while "New output below" appears; scrolling further up shows earlier lines;
//  - Jump to latest follows again with a newer line; scrolling back up and then to the bottom follows again too;
//  - the full-screen pane: "redraws its whole screen", still following;
//  - the pane was never put in a mode, and its output never stopped (scrolling cannot affect delivery);
//  - no page error, no CSP violation, no horizontal page overflow on the phone.
//   PW_DIR=… REPO=… OUT=… npx --prefix <checkout> tsx scripts/manual/smoke/smoke-view-scrollback.mts
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, freshPage, mounted, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-view-scrollback";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48870), classic: false, instances: 4 });
const fm = fx.fm;
const { getTmuxSocketName } = await import(process.env.REPO + "/src/paths.ts");
const { getTmuxSession } = await import(process.env.REPO + "/src/config.ts");
const socket = getTmuxSocketName(), session = getTmuxSession();
if (!socket) throw new Error("the fixture's home must give a private tmux socket");
const tmux = (...args: string[]) => execFileSync("tmux", ["-L", socket, ...args], { encoding: "utf8" });
const names = Object.keys(fm.fleetConfig.instances).filter((n: string) => !fm.fleetConfig.instances[n].general_topic);
const [live, full] = [names[0]!, names[1]!];
const script = join(fx.dir, "live.py");
writeFileSync(script, "import sys,time\nn=0\nwhile True:\n  n+=1\n  sys.stdout.write('\\x1b[3%dmline %d\\x1b[0m the agent says something useful here\\n' % (n % 6 + 1, n)); sys.stdout.flush(); time.sleep(0.1)\n");
tmux("new-session", "-d", "-s", session, "-x", "110", "-y", "30", "-n", "live", `python3 ${script}`);
tmux("new-window", "-t", session, "-n", "full", "printf '\\033[?1049h'; while true; do printf '\\033[H\\033[2Jfull-screen CLI %s' \"$(date +%T)\"; sleep 1; done");
for (const [name, win] of [[live, "live"], [full, "full"]] as const) {
  const wid = tmux("display-message", "-p", "-t", `${session}:${win}`, "#{window_id}").trim();
  mkdirSync(join(fx.dir, "instances", name), { recursive: true });
  writeFileSync(join(fx.dir, "instances", name, "window-id"), wid);
}
const paneLine = () => { const m = /line (\d+)/g, t = tmux("capture-pane", "-p", "-t", `${session}:live`); let n = 0, k; while ((k = m.exec(t))) n = Number(k[1]); return n; };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const results: Array<{ name: string; ok: boolean; failed: string[] }> = [];
const T = { en: { earlier: "Earlier output", newBelow: "New output below", latest: "Jump to latest", none: "redraws its whole screen" },
  "zh-TW": { earlier: "較早的輸出", newBelow: "下方有新的輸出", latest: "跳到最新", none: "重繪整個畫面" } } as const;

for (const c of [{ device: "desk", theme: "light", lang: "en" }, { device: "phone", theme: "dark", lang: "zh-TW" }] as const) {
  const failed: string[] = [];
  const need = (ok: boolean, what: string) => { if (!ok) failed.push(what); };
  const p = await freshPage(fx, c as any, { account: "operator" });
  const page = p.page, t = T[c.lang];
  try {
    await mounted(page, 30000);
    await page.goto(`${p.base}/view/${encodeURIComponent(live)}`);
    await page.waitForSelector(".v-pre", { timeout: 20000 });
    await page.waitForFunction(() => /line \d+/.test(document.querySelector(".v-pre")!.textContent || ""), null, { timeout: 15000 });
    while (paneLine() < 60) await sleep(200);                     // more than one screen (30 rows) has scrolled off
    await sleep(1000);
    const state = () => page.evaluate(`(() => { const t = document.querySelector(".v-term"), p = document.querySelector(".v-pre");
      const nums = [...p.textContent.matchAll(/line (\\d+)/g)].map(m => Number(m[1]));
      return { reading: t.className.includes("is-reading"), top: t.scrollTop, max: t.scrollHeight - t.clientHeight, first: nums[0] ?? null, last: nums.at(-1) ?? null, text: p.textContent.length,
        earlier: document.querySelector(".v-term-earlier")?.textContent || "", latest: document.querySelector(".v-term-latest")?.textContent || "",
        note: document.querySelector(".v-term-history-note")?.textContent || "", overflow: document.scrollingElement.scrollWidth - innerWidth }; })()`) as Promise<any>;
    const s0 = await state();
    need(!s0.reading && s0.earlier.includes(t.earlier) && s0.last > 10, `following with the newest lines, Earlier output offered (${JSON.stringify(s0).slice(0, 160)})`);
    await page.screenshot({ path: shotPath(SMOKE, c as any, "following") });
    // Scroll up during live output.
    const box = (await page.locator(".v-term").boundingBox())!;
    if (c.device === "desk") { await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.wheel(0, -400); }
    else {
      const cdp = await p.ctx.newCDPSession(page), x = box.x + box.width / 2, y = box.y + 60;
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      for (let i = 1; i <= 6; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + i * 20 }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    }
    await page.waitForFunction(() => document.querySelector(".v-term")!.className.includes("is-reading"), null, { timeout: 8000 }).catch(() => {});
    await sleep(300);
    const s1 = await state();
    need(s1.reading && s1.first === 1, `reading, with the scrollback from line 1 (${JSON.stringify(s1).slice(0, 160)})`);
    await sleep(3000);
    const s2 = await state();
    need(s2.text === s1.text && s2.last === s1.last && Math.abs(s2.top - s1.top) < 2, `no yank for 3 s of live output (top ${s1.top}→${s2.top}, last ${s1.last}→${s2.last})`);
    need(s2.latest.includes(t.newBelow) && s2.latest.includes(t.latest), `"New output below · Jump to latest" (${s2.latest})`);
    await page.locator(".v-term").evaluate((el: any) => { el.scrollTop = Math.max(0, el.scrollTop - 600); });
    await sleep(300);
    const s3 = await state();
    need(s3.reading && s3.top < s2.top, `scrolling further up stays reading (${s2.top}→${s3.top})`);
    await page.screenshot({ path: shotPath(SMOKE, c as any, "reading") });
    // Jump to latest.
    await page.locator(".v-term-latest").click();
    await sleep(1200);
    const s4 = await state();
    need(!s4.reading && s4.last > s2.last && s4.earlier.includes(t.earlier), `Jump to latest follows again with newer output (last ${s2.last}→${s4.last})`);
    // Up again, then to the bottom: following again.
    await page.locator(".v-term-earlier").click();
    await page.waitForFunction(() => document.querySelector(".v-term")!.className.includes("is-reading"), null, { timeout: 8000 }).catch(() => {});
    await page.locator(".v-term").evaluate((el: any) => { el.scrollTop = el.scrollHeight; });
    await sleep(1200);
    need(!(await state()).reading, "scrolling to the bottom follows again");
    need((await state()).overflow <= 0, "no horizontal page overflow");
    // The full-screen pane.
    await page.goto(`${p.base}/view/${encodeURIComponent(full)}`);
    await page.waitForFunction(() => /full-screen CLI/.test(document.querySelector(".v-pre")?.textContent || ""), null, { timeout: 15000 });
    await page.locator(".v-term-earlier").click();
    await sleep(1200);
    const s5 = await state();
    need(!s5.reading && s5.note.includes(t.none), `a full-screen CLI: no scrollback, said, still following (${s5.note})`);
    await page.screenshot({ path: shotPath(SMOKE, c as any, "full-screen") });
    need(p.errors.length === 0, `no page error or CSP violation: ${p.errors.slice(0, 2).join(" / ")}`);
  } catch (e) { failed.push(`threw: ${String(e).slice(0, 300)}`); }
  await p.ctx.close();
  results.push({ name: `${c.device}-${c.theme}-${c.lang}`, ok: !failed.length, failed });
}
// The pane itself: never put in a mode, and its output never stopped.
{
  const failed: string[] = [];
  const a = paneLine(); await sleep(1500); const b = paneLine();
  if (tmux("display-message", "-p", "-t", `${session}:live`, "#{pane_in_mode}").trim() !== "0") failed.push("the pane is in a mode");
  if (!(b > a)) failed.push(`its output stopped (${a}→${b})`);
  results.push({ name: "the pane: never in a mode, output never stopped", ok: !failed.length, failed });
}
try { tmux("kill-server"); } catch { /* gone */ }
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.failed.length ? " — " + r.failed.join("; ") : ""}`);
await fx.close();
process.exit(results.every(r => r.ok) ? 0 : 1);
