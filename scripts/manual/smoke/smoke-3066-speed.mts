// #3066 §2 on the realistic fixture: output speed after the first token, read by the product's own scan from transcripts
// in their real shapes, in Chromium. A Claude Code session of 40 responses, each with a leading thinking block carrying
// thinkingDurationMs (600 tokens in 7 s after the first token → 86 tok/s), and a Codex rollout as codex 0.165 writes it
// (item_completed clocks, a token_usage_record per response: 400 tokens in 4 s → 100 tok/s). Fleet → Usage, desk light en
// and phone dark zh-TW: the Speed column, the "Speed by model" card (rate · timed of requests · p10–p90 from 30). Then a
// stale tab (quality rule 3), both ways, via request interception: the new fleet-usage.js with the previous app.css, and
// the previous fleet-usage.js with the new app.css — every row, no page error. Scratch CLAUDE_CONFIG_DIR / CODEX_HOME.
//   PW_DIR=… REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf SKEW_OLD_CSS=<file> SKEW_OLD_JS=<file> \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-3066-speed.mts
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootFixture, freshPage, mounted, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-3066-speed", REPO = process.env.REPO!;
const SRC = mkdtempSync(join(tmpdir(), "smoke-3066-speed-src-"));
process.env.CLAUDE_CONFIG_DIR = join(SRC, "claude");
process.env.CODEX_HOME = join(SRC, "codex");
const fx = await bootFixture({ port: Number(process.env.HP ?? 48620), instances: 14, classic: false });
const fm = fx.fm;
const { claudeProjectKey } = await import(REPO + "/src/backend/claude-code.ts");
const byBackend = (b: string) => fx.instances.filter((i: any) => i.backend === b).map((i: any) => i.name);
const [A] = byBackend("claude-code"), [X] = byBackend("codex");
for (const name of Object.keys(fm.fleetConfig.instances)) if (name !== A && name !== X) delete fm.fleetConfig.instances[name];
for (const name of [A, X]) { const wd = join(SRC, "wd", name!); mkdirSync(wd, { recursive: true }); fm.fleetConfig.instances[name!].working_directory = wd; }
const wdOf = (n: string) => fm.fleetConfig.instances[n].working_directory as string;

const now = Date.now(), base = now - 3 * 3_600_000;
const iso = (t: number) => new Date(t).toISOString();
// Claude: 40 responses a minute apart; each: a thinking block (1 s of thinking, stamped at +3 s) and a text block at +9 s.
{
  const lines: string[] = [];
  for (let i = 0; i < 40; i++) {
    const t = base + i * 60_000, id = `msg_${String(i).padStart(3, "0")}`;
    lines.push(JSON.stringify({ type: "user", timestamp: iso(t), message: { role: "user", content: "go" } }));
    const usage = { input_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, output_tokens: 600 };
    lines.push(JSON.stringify({ type: "assistant", timestamp: iso(t + 3_000), thinkingDurationMs: 1_000, message: { id, role: "assistant", model: "claude-opus-4-5", stop_reason: null, content: [{ type: "thinking", thinking: "…" }], usage } }));
    lines.push(JSON.stringify({ type: "assistant", timestamp: iso(t + 9_000), message: { id, role: "assistant", model: "claude-opus-4-5", stop_reason: "end_turn", content: [{ type: "text", text: "done" }], usage } }));
  }
  const dir = join(process.env.CLAUDE_CONFIG_DIR!, "projects", claudeProjectKey(wdOf(A!)));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "s.jsonl"), lines.join("\n") + "\n");
}
// Codex 0.165: five turns (task_started … task_complete), each one response — Reasoning (1 s) then AgentMessage (3 s),
// closed by its token_usage_record and counted by the token_count after it.
{
  const day = iso(base).slice(0, 10), lines: string[] = [];
  lines.push(JSON.stringify({ timestamp: iso(base), type: "session_meta", payload: { id: "s", cwd: wdOf(X!), originator: "codex_cli_rs", cli_version: "0.165.0" } }));
  lines.push(JSON.stringify({ timestamp: iso(base), type: "turn_context", payload: { model: "gpt-5.5", cwd: wdOf(X!) } }));
  for (let i = 0; i < 5; i++) {
    const t = base + i * 120_000;
    lines.push(JSON.stringify({ timestamp: iso(t - 10), type: "event_msg", payload: { type: "task_started", turn_attribution: { turn_id: `u${i}` }, turn_id: `u${i}` } }));
    lines.push(JSON.stringify({ timestamp: iso(t + 1_000), type: "event_msg", payload: { type: "item_completed", thread_id: "s", turn_id: `u${i}`, started_at_ms: t, completed_at_ms: t + 1_000, item: { type: "Reasoning", id: `r${i}` } } }));
    lines.push(JSON.stringify({ timestamp: iso(t + 4_000), type: "event_msg", payload: { type: "item_completed", thread_id: "s", turn_id: `u${i}`, started_at_ms: t + 1_000, completed_at_ms: t + 4_000, item: { type: "AgentMessage", id: `m${i}` } } }));
    lines.push(JSON.stringify({ timestamp: iso(t + 4_010), type: "token_usage_record", payload: { thread_id: "s", turn_id: `u${i}`, response_id: `resp${i}`, usage: { input_tokens: 2000, cached_input_tokens: 1500, output_tokens: 400 } } }));
    lines.push(JSON.stringify({ timestamp: iso(t + 4_020), type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 2000 * (i + 1), cached_input_tokens: 1500 * (i + 1), output_tokens: 400 * (i + 1), total_tokens: 2400 * (i + 1) },
      last_token_usage: { input_tokens: 2000, cached_input_tokens: 1500, cache_write_input_tokens: 0, output_tokens: 400, reasoning_output_tokens: 0, total_tokens: 2400 } } } }));
    lines.push(JSON.stringify({ timestamp: iso(t + 4_030), type: "event_msg", payload: { type: "task_complete", turn_id: `u${i}` } }));
  }
  const dir = join(process.env.CODEX_HOME!, "sessions", day.replace(/-/g, "/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `rollout-${day}T09-00-00-smoke.jsonl`), lines.join("\n") + "\n");
}
const readAll = async () => { const d = await fm.cacheServiceFor().usageData(); return [A, X].every(n => Object.keys(d.instances.find((i: any) => i.inst.name === n)?.ledger.hours ?? {}).length > 0); };
for (let k = 0; k < 30 && !(await readAll()); k++) { await fm.cacheServiceFor().kick(); await new Promise(r => setTimeout(r, 1200)); }

const failed: string[] = [];
const check = (ok: boolean, what: string) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failed.push(what); };
check(await readAll(), "setup: the product read both transcripts");
async function toUsage(page: any) {
  await page.goto(new URL("/ui/fleet/usage", page.url()).href);               // the phone has no sidebar: the route itself
  await page.waitForSelector(".us-row", { timeout: 15000 });
}
const scrape = (page: any) => page.evaluate(`(() => ({
  heads: [...document.querySelectorAll(".us-table thead th")].map((t) => t.textContent),
  speed: Object.fromEntries([...document.querySelectorAll(".us-row")].map((r) => [r.querySelector(".us-name .mono").textContent, [...r.querySelectorAll("td")].at(-1).textContent])),
  card: [...document.querySelectorAll(".us-speed .row-item")].map((li) => li.textContent),
  note: document.querySelector(".us-speed .note")?.textContent ?? null,
  overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 }))()`);

for (const c of [{ device: "desk", theme: "light", lang: "en" }, { device: "phone", theme: "dark", lang: "zh-TW" }] as const) {
  const p = await freshPage(fx, c);
  check(await mounted(p.page), `${c.device}: the app mounted`);
  await toUsage(p.page);
  const s: any = await scrape(p.page);
  const zh = c.lang === "zh-TW";
  if (c.device === "desk") check(s.heads.at(-1) === (zh ? "速度" : "Speed"), `${c.device}: the Speed column (${s.heads.join(" | ")})`);
  check(s.speed[A!] === (zh ? "86 token/秒" : "86 tok/s"), `${c.device}: Claude ${s.speed[A!]}`);
  check(s.speed[X!] === (zh ? "100 token/秒" : "100 tok/s"), `${c.device}: Codex ${s.speed[X!]}`);
  const claudeLine = s.card.find((l: string) => l.startsWith("claude-opus-4-5")), codexLine = s.card.find((l: string) => l.startsWith("gpt-5.5"));
  check(!!codexLine && codexLine.includes(zh ? "5 個請求中有 5 個可計時" : "5 of 5 requests timed") && !codexLine.includes("p10"), `${c.device}: Codex card line (under 30: no spread) "${codexLine}"`);
  check(!!claudeLine && claudeLine.includes(zh ? "40 個請求中有 40 個可計時" : "40 of 40 requests timed") && claudeLine.includes("p10–p90"), `${c.device}: Claude card line (40: a spread) "${claudeLine}"`);
  check(s.note === (zh ? "輸出 token ÷ 模型本身的回應時間（不含工具執行時間）；方法參考 tokdash。" : "Output tokens ÷ the model's own response time (tool time excluded); method after tokdash."), `${c.device}: the basis note`);
  check(!s.overflow, `${c.device}: no horizontal overflow`);
  check(p.errors.length === 0, `${c.device}: no page errors (${p.errors.join(" | ")})`);
  await p.page.screenshot({ path: shotPath(SMOKE, c, "usage"), fullPage: true });
  await p.ctx.close();
}

if (process.env.SKEW_OLD_CSS && process.env.SKEW_OLD_JS) {
  const oldCss = readFileSync(process.env.SKEW_OLD_CSS, "utf8"), oldJs = readFileSync(process.env.SKEW_OLD_JS, "utf8");
  for (const [mix, pattern, body, type] of [["new-js-old-css", "**/assets/app.css", oldCss, "text/css; charset=utf-8"], ["old-js-new-css", "**/ui/js/fleet-usage.js", oldJs, "text/javascript; charset=utf-8"]] as const) {
    const c = { device: "desk", theme: "light", lang: "en" } as const;
    const p = await freshPage(fx, c, { beforeNavigate: (ctx: any) => ctx.route(pattern, (r: any) => r.fulfill({ status: 200, contentType: type, body })) });
    await toUsage(p.page);
    const s: any = await scrape(p.page);
    check(Object.keys(s.speed).length === 2, `skew ${mix}: both rows`);
    if (mix === "new-js-old-css") check(s.speed[A!] === "86 tok/s" && s.card.length === 2, `skew ${mix}: the Speed column and card (unstyled, legible)`);
    else check(!s.heads.includes("Speed"), `skew ${mix}: the old table, as before`);
    check(!s.overflow && p.errors.length === 0, `skew ${mix}: no overflow, no page error (${p.errors.join(" | ")})`);
    await p.page.screenshot({ path: shotPath(SMOKE, c, `skew-${mix}`), fullPage: true });
    await p.ctx.close();
  }
} else console.log("skew: skipped (set SKEW_OLD_CSS and SKEW_OLD_JS)");

console.log(failed.length ? `${SMOKE}: ${failed.length} FAILED` : `${SMOKE}: PASS`);
await fx.close(); process.exit(failed.length ? 1 : 0);
