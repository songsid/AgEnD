/**
 * M-3326 (the user, 11-18): a Hub room's table cells selected as the Fleet chat's (chat-table-select.js, the same module):
 * press in a cell of a room message's Markdown table and drag down — only that column's cells; diagonally — a block;
 * Ctrl+C copies them as TSV. A real browser on a real Hub (HTTPS + SQLite; a synthetic directory; no agent, Fleet, native
 * process or account). Cases: desk light en, desk dark zh-TW. Pictures: <case>-<step>.png.
 * BASELINE=1 (the base): expects the gap (no cells, no column on the clipboard).
 *   REPO=<checkout> OUT=<dir> PW_DIR=<dir with playwright-core> [CHROME=<path>] [BASELINE=1] npx tsx scripts/manual/smoke/smoke-hub-room-table-cells-m3326.mts
 */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
const repo = process.env.REPO!, out = process.env.OUT!, pwDir = process.env.PW_DIR!, baseline = process.env.BASELINE === "1";
if (!repo || !out || !pwDir) throw Error("REPO/OUT/PW_DIR required");
mkdirSync(out, { recursive: true });
const { s3bRig } = await import(repo + "/tests/helpers/hub-s3b-rig.ts");
const { freeHubPort } = await import(repo + "/tests/helpers/hub-rig.ts");
const { provisionHubIdentity } = await import(repo + "/src/hub/tls.ts");
const { personKeyString } = await import(repo + "/src/hub/identity.ts");
const port = await freeHubPort(), origin = `https://127.0.0.1:${port}`;
const rig = await s3bRig({ webOrigin: origin, attachments: true });   // rooms that take files (attachments-v1)
const keys = mkdtempSync(join(out, "owned-keys-")); chmodSync(keys, 0o700);
await provisionHubIdentity({ home: keys, memberOrigin: origin });
const server = createServer({ key: readFileSync(join(keys, "hub/keys/tls-key.pem")), cert: readFileSync(join(keys, "hub/keys/tls-cert.pem")) },
  (req, res) => { if (!rig.http.handle(req, res)) { res.writeHead(404); res.end(); } });
await new Promise<void>((r, j) => { server.once("error", j); server.listen(port, "127.0.0.1", r); });
const pw = createRequire(pwDir + "/")("playwright-core");
const browser = await pw.chromium.launch({ executablePath: process.env.CHROME, args: ["--no-sandbox"] });
const receipt: any = { source: execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), baseline, cases: [], pageErrors: [], foreign: [] };
const check = (ok: unknown, msg: string) => { if (!ok) throw Error(msg); };
const shot = async (p: any, n: string) => { await p.evaluate(() => document.fonts.ready); await p.screenshot({ path: join(out, n + ".png"), fullPage: false }); };
const admin = await rig.signIn("admin");
const cases = [{ device: "desk", theme: "light", lang: "en" }, { device: "desk", theme: "dark", lang: "zh-TW" }];
const TABLES: any = {
  en: "Who runs what:\n\n| Agent | Model | Backend | Since |\n|---|---|---|---|\n| Notes | opus | claude-code | Mon |\n| Lumen | fable | claude-code | Tue |\n| Argon | gemini 3 | agy | Wed |\n| Cairn | sonnet | claude-code | Thu |",
  "zh-TW": "誰負責什麼：\n\n| Agent | 模型 | 後端 | 開始 |\n|---|---|---|---|\n| Notes | opus | claude-code | 週一 |\n| Lumen | fable | claude-code | 週二 |\n| Argon | gemini 3 | agy | 週三 |\n| Cairn | sonnet | claude-code | 週四 |",
};
try {
  for (const [i, c] of cases.entries()) {
    const tag = `${c.device}-${c.theme}-${c.lang}`, row: any = { tag, steps: {} }; receipt.cases.push(row);
    const login = "alex" + i, alex = rig.addPerson(login, "Alex"); await rig.signIn(login);
    const room = (await rig.call(admin, "POST", "/hub/v1/rooms", { name: `Cells ${tag}`, people: [personKeyString(alex)] })).json.room.id as string;
    await rig.call(admin, "POST", `/hub/v1/rooms/${room}/messages`, { text: TABLES[c.lang], mentions: [], idempotencyKey: randomUUID() });
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: c.lang === "en" ? "en-US" : "zh-TW", colorScheme: c.theme, ignoreHTTPSErrors: true });
    await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
    await ctx.addInitScript({ content: `window.__name=fn=>fn;localStorage.setItem('agend_lang',${JSON.stringify(c.lang)});localStorage.setItem('agend_theme',${JSON.stringify(c.theme)});` });
    await ctx.route("**/*", (route: any) => { const u = new URL(route.request().url()); if (u.origin !== origin) { receipt.foreign.push(u.origin); return route.abort(); } return route.continue(); });
    const p = await ctx.newPage(); p.setDefaultTimeout(15000);
    p.on("pageerror", (e: any) => receipt.pageErrors.push(`${tag}: ${String(e)}`));
    try {
      await p.goto(origin + "/ui/hub"); await p.fill("#hubLogin", login); await p.fill("#hubPassword", "pw-" + login);
      await p.locator(".hub-signin button[type=submit]").click(); await p.locator(".hub-session-row").first().waitFor({ state: "attached" });
      await p.goto(`${origin}/ui/hub?room=${room}`); await p.locator(".hub-room-page .msg .md table").first().waitFor(); await p.waitForTimeout(600);
      await p.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      const T = `document.querySelector(".hub-room-page .msg .md table")`;
      const at = async (r: number, col: number) => p.evaluate(`(() => { const b = (${T}).rows[${r}].cells[${col}].getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`) as Promise<any>;
      const state = () => p.evaluate(`(() => { const t = ${T}; return { sel: [...t.rows].map((tr) => [...tr.cells].map((c) => c.classList.contains("cell-sel") ? 1 : 0).join("")).join("|"), on: t.classList.contains("cells-on") }; })()`) as Promise<any>;
      const drag = async (a0: [number, number], b0: [number, number]) => { const a = await at(...a0), b = await at(...b0); await p.mouse.move(a.x - 6, a.y); await p.mouse.down(); await p.mouse.move(b.x, b.y, { steps: 8 }); await p.mouse.up(); await p.waitForTimeout(150); };
      const clip = async () => { await p.keyboard.press("Control+C"); await p.waitForTimeout(150); return p.evaluate(() => navigator.clipboard.readText().catch(() => "")); };
      await drag([1, 1], [4, 1]);
      row.steps.column = await state(); row.steps.columnClip = await clip(); await shot(p, `${tag}-1-column`);
      if (baseline) {
        check(row.steps.column.sel === "0000|0000|0000|0000|0000" && row.steps.columnClip !== "opus\nfable\ngemini 3\nsonnet", `baseline: expected no cells (${JSON.stringify(row.steps)})`);
        row.status = "BASELINE_REPRODUCED"; continue;
      }
      check(row.steps.column.sel === "0000|0100|0100|0100|0100" && row.steps.column.on, `column: ${JSON.stringify(row.steps.column)}`);
      check(row.steps.columnClip === "opus\nfable\ngemini 3\nsonnet", `column TSV: ${JSON.stringify(row.steps.columnClip)}`);
      await drag([2, 0], [3, 2]);
      row.steps.block = await state(); row.steps.blockClip = await clip(); await shot(p, `${tag}-2-block`);
      check(row.steps.block.sel === "0000|0000|1110|1110|0000", `block: ${JSON.stringify(row.steps.block)}`);
      check(row.steps.blockClip === "Lumen\tfable\tclaude-code\nArgon\tgemini 3\tagy", `block TSV: ${JSON.stringify(row.steps.blockClip)}`);
      await p.keyboard.press("Escape"); await p.waitForTimeout(100);
      row.steps.esc = await state();
      check(row.steps.esc.sel === "0000|0000|0000|0000|0000" && !row.steps.esc.on, `Esc: ${JSON.stringify(row.steps.esc)}`);
      row.status = "PASS";
    } catch (e: any) { row.status = "FAIL"; row.error = String(e?.stack || e).slice(0, 800); await shot(p, `${tag}-FAIL`).catch(() => {}); }
    finally { await ctx.close(); }
  }
} finally {
  await browser.close(); await new Promise<void>(r => server.close(() => r())); await rig.close(); rmSync(keys, { recursive: true, force: true });
  receipt.status = receipt.cases.length === cases.length && receipt.cases.every((x: any) => x.status === (baseline ? "BASELINE_REPRODUCED" : "PASS")) && !receipt.pageErrors.length ? "PASS" : "FAIL";
  writeFileSync(join(out, "receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ source: receipt.source, baseline, status: receipt.status, cases: receipt.cases.map((x: any) => ({ tag: x.tag, status: x.status, error: x.error, steps: x.steps })), pageErrors: receipt.pageErrors, foreign: receipt.foreign }));
}
process.exitCode = receipt.status === "PASS" ? 0 : 1;
