// mock-3639.mts: zh-TW mockups for #3639 (tool progress in the web chat), drawn ON the real dashboard (agend-rha13-W): the real
// shell, thread and styles; the proposed block is injected into the thread where the reply will appear. Nothing is saved.
//   PW_DIR=… OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf npx --prefix <repo> tsx mock-3639.mts
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
const OUT = process.env.OUT!, BASE = "http://127.0.0.1:19497";
mkdirSync(OUT, { recursive: true });
const docker = (cmd: string) => execFileSync("docker", ["exec", "agend-rha13-W", "bash", "-c", cmd], { encoding: "utf8", env: { ...process.env, DOCKER_CONFIG: `${process.env.HOME}/.cache/agend-rh-2264/dockercfg` } }).trim();
const code = () => JSON.parse(docker(`curl -s -X POST -H "X-Agend-Token: $(cat /home/rh/.agend/web.token)" http://127.0.0.1:19280/auth/issue-code`)).code as string;
const pw = createRequire(process.env.PW_DIR + "/")("playwright-core");
const browser = await pw.chromium.launch({ args: ["--no-sandbox"] });

const CSS = `
.msg.tp-host { padding-block: 2px; }
.tp { border: 1px solid var(--border); border-radius: 10px; background: var(--surface-2); max-width: 640px; }
.tp > summary { list-style: none; display: flex; align-items: center; gap: 8px; padding: 8px 12px; cursor: pointer; min-height: 40px; color: var(--text-2); font-size: 13.5px; }
.tp > summary::-webkit-details-marker { display: none; }
.tp > summary::before { content: "▸"; flex: none; color: var(--text-3); transition: transform .15s; }
.tp[open] > summary::before { transform: rotate(90deg); }
.tp .tp-now { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); }
.tp .tp-meta { flex: none; color: var(--text-3); font-variant-numeric: tabular-nums; }
.tp .tp-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 3px var(--accent-dim); }
.tp.done .tp-now { color: var(--text-2); }
.tp ol { margin: 0; padding: 4px 12px 10px 34px; border-top: 1px solid var(--border); max-height: 32vh; overflow: auto; font-size: 13px; color: var(--text-2); }
.tp ol li { padding: 3px 0; overflow-wrap: anywhere; }
.tp ol li.now { color: var(--text); font-weight: 500; }
.tp ol li.more { list-style: none; margin-inline-start: -22px; color: var(--text-3); font-size: 12px; }
.tp ol li code { font-size: 12px; background: var(--surface); border: 1px solid var(--border); border-radius: 4px; padding: 0 4px; }
`;
const STEPS_STD = ["🔍 搜尋程式碼", "📄 讀取檔案：…/src/ui/panel-chat.js", "📄 讀取檔案：…/src/ui/chat-store.js", "✏️ 編輯檔案：…/src/ui/panel-chat.js", "🔨 建置／型別檢查", "🧪 執行測試", "📄 讀取檔案：…/tests/web-chat-progress.test.ts"];
const STEPS_VERBOSE = ["🔍 搜尋程式碼", "📄 讀取檔案：…/src/ui/panel-chat.js", "📄 讀取檔案：…/src/ui/chat-store.js", "✏️ 編輯檔案：…/src/ui/panel-chat.js", "🔨 建置／型別檢查：<code>npm run typecheck</code>", "🧪 執行測試：<code>npx vitest run tests/web-chat-pro…</code>", "📄 讀取檔案：…/tests/web-chat-progress.test.ts"];
const FINISHED = ["🔍 搜尋程式碼", "📄 讀取檔案：…/src/ui/panel-chat.js", "✏️ 編輯檔案：…/src/ui/panel-chat.js", "🔨 建置／型別檢查", "🧪 執行測試", "✏️ 編輯檔案：…/tests/web-chat-progress.test.ts", "🧪 執行測試", "💾 git commit"];

function block(state: "run" | "done", open: boolean, steps: string[], count: number, elapsed: string) {
  const now = steps[steps.length - 1].replace(/<[^>]+>/g, "");
  const summary = state === "run"
    ? `<span class="tp-dot"></span><span class="tp-now">${now}</span><span class="tp-meta">${count} 個工具 · ${elapsed}</span>`
    : `<span class="tp-now">🧾 工具歷程 · 用了 ${count} 個工具</span><span class="tp-meta">${elapsed}</span>`;
  const shown = steps.slice(-8);
  const more = count > shown.length ? `<li class="more">… 前面還有 ${count - shown.length} 步（只保留最近 8 步）</li>` : "";
  const items = shown.map((s, i) => `<li class="${state === "run" && i === shown.length - 1 ? "now" : ""}">${s}</li>`).join("");
  return `<div class="msg agent tp-host"><div class="meta"><span class="sender">probe</span><span class="time">08:52</span></div>
    <details class="tp ${state === "done" ? "done" : ""}" ${open ? "open" : ""}><summary>${summary}</summary><ol>${more}${items}</ol></details></div>`;
}
const USER = `<div class="msg user"><div class="meta"><span class="sender">你</span><span class="time">08:51</span></div><div class="body"><div class="md"><p>panel-chat.js 的進度區塊壞了，幫我修好並跑測試。</p></div></div></div>`;
const REPLY = `<div class="msg agent"><div class="meta"><span class="sender">probe</span><span class="time">08:55</span></div><div class="body"><div class="md"><p>修好了：進度區塊在回合結束時會收成一行摘要，不再重複。<code>tests/web-chat-progress.test.ts</code> 全部通過，已提交。</p></div></div></div>`;
const WORKBAR = `<div class="work-bar working tp-fake"><span class="pulse"></span><span class="lbl">probe 處理中…</span><span class="elapsed">1 分 05 秒</span></div>`;

async function scene(name: string, opts: { width: number; height: number; dark?: boolean; mobile?: boolean }, html: string, running: boolean) {
  const ctx = await browser.newContext({ viewport: { width: opts.width, height: opts.height }, colorScheme: opts.dark ? "dark" : "light", locale: "zh-TW", bypassCSP: true, isMobile: !!opts.mobile, hasTouch: !!opts.mobile, deviceScaleFactor: opts.mobile ? 2 : 1 });
  await ctx.addInitScript({ content: `try { localStorage.setItem("agend_tour_done", "1"); localStorage.setItem("agend_lang", "zh-TW"); } catch {}` });
  const p = await ctx.newPage();
  await p.goto(`${BASE}/signin`); await p.waitForTimeout(1000);
  await p.evaluate(`fetch("/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "${code()}" }) })`);
  await p.evaluate(`fetch("/auth/session").then(r => r.json()).then(s => fetch("/ui/prefs", { method: "POST", headers: { "content-type": "application/json", "x-agend-csrf": s.csrf }, body: JSON.stringify({ set: { lang: "zh-TW", theme: "${opts.dark ? "dark" : "light"}" } }) }))`);
  await p.goto(`${BASE}/ui/chat/probe`); await p.waitForSelector("#msgIn", { timeout: 20000 }); await p.waitForTimeout(3000);
  await p.addStyleTag({ content: CSS });
  await p.evaluate(({ html, running, wb }: any) => {
    const t = document.querySelector(".thread")!; t.innerHTML = html;
    document.querySelectorAll(".work-bar").forEach(e => e.remove());
    if (running) { const c = document.querySelector("#msgIn")?.closest("form, .composer, .dock") as HTMLElement | null; c?.insertAdjacentHTML("beforebegin", wb); }
    const sc = document.querySelector(".scroller"); if (sc) sc.scrollTop = sc.scrollHeight;
    { const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) { if (/已停止/.test(n.data) && (n.parentElement?.getBoundingClientRect().top ?? 999) < 80) n.data = n.data.replace("已停止", running ? "工作中" : "閒置"); } }
  }, { html, running, wb: WORKBAR });
  await p.waitForTimeout(600);
  await p.screenshot({ path: join(OUT, `${name}.png`) });
  await ctx.close();
}
const D = { width: 1366, height: 820 }, P = { width: 390, height: 844, mobile: true };
const run = (open: boolean, steps = STEPS_STD) => USER + block("run", open, steps, 7, "1 分 05 秒");
const done = (open: boolean) => USER + block("done", open, FINISHED, 12, "3 分 12 秒") + REPLY;
try {
  await scene("1-desktop-running-collapsed", D, run(false), true);
  await scene("2-desktop-running-expanded", D, run(true), true);
  await scene("3-desktop-finished-collapsed", D, done(false), false);
  await scene("4-desktop-finished-expanded", D, done(true), false);
  await scene("5-desktop-verbose-expanded", D, run(true, STEPS_VERBOSE), true);
  await scene("6-phone-running-collapsed", P, run(false), true);
  await scene("7-phone-running-expanded", P, run(true), true);
  await scene("8-phone-finished-collapsed", P, done(false), false);
  await scene("9-desktop-dark-running-expanded", { ...D, dark: true }, run(true), true);
  console.log("ok");
} catch (e) { console.log(String((e as Error).stack ?? e).slice(0, 800)); }
finally { await browser.close(); }
