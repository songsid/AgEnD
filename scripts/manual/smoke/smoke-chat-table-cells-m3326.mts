// M-3326 (the user, 11-18): a chat table's cells selected as a spreadsheet's (Outline's tables). A real headless Chrome on
// the shared smoke fixture (the product's own web server from an in-process FleetManager, a scratch home, loopback only —
// no fleet start, no network), an agent's message with a Markdown table, a real mouse. Per case:
//   desk — press in a cell and drag straight down: only that column's cells are selected (and the browser's text
//          selection is empty); Ctrl+C puts them on the clipboard as TSV; diagonally: a block; Esc clears it; a drag inside
//          one cell is still the browser's own text selection, with 「引用」 (#4155); the message menu still opens (Reply,
//          Copy text);
//   phone (a coarse pointer) — the same drag selects no cells.
// BASELINE=1 (the base): expects the gap — the drag down a column selects no cells, and Ctrl+C has no column to copy.
// (Headless Chrome's own drag across table rows leaves a caret, so the base's whole-row text selection is not drawn here.)
//   PW_DIR=<playwright-core dir> REPO=<checkout> OUT=<dir> [MATRIX=…] [BASELINE=1] npx tsx scripts/manual/smoke/smoke-chat-table-cells-m3326.mts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, caseName, matrix, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = process.env.SMOKE_NAME ?? "smoke-chat-table-cells-m3326";
const OUT = join(process.env.OUT ?? "/tmp/smoke-out", SMOKE);
const BASELINE = process.env.BASELINE === "1";
mkdirSync(OUT, { recursive: true });
const r: Record<string, unknown> = { baseline: BASELINE };
const fail: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => { r[name] = ok ? "PASS" : { FAIL: detail ?? true }; if (!ok) fail.push(name); };

const fx = await bootFixture({ port: Number(process.env.HP ?? 48326), instances: 6 });
const name = fx.instances[2]!.name;
const now = Date.now();
const TABLES = {
  en: "Who runs what:\n\n| Agent | Model | Backend | Since |\n|---|---|---|---|\n| Notes | opus | claude-code | Mon |\n| Lumen | fable | claude-code | Tue |\n| Argon | gemini 3 | agy | Wed |\n| Cairn | sonnet | claude-code | Thu |",
  "zh-TW": "誰負責什麼：\n\n| Agent | 模型 | 後端 | 開始 |\n|---|---|---|---|\n| Notes | opus | claude-code | 週一 |\n| Lumen | fable | claude-code | 週二 |\n| Argon | gemini 3 | agy | 週三 |\n| Cairn | sonnet | claude-code | 週四 |",
};
fx.fm.emitSseEvent("message", { instance: name, sender: name, role: "agent", text: TABLES.en, ts: new Date(now - 600_000).toISOString() });
fx.fm.emitSseEvent("message", { instance: name, sender: name, role: "agent", text: TABLES["zh-TW"], ts: new Date(now - 540_000).toISOString() });

const CASES = matrix(process.env.MATRIX ?? "desk-light-en,desk-dark-zh-TW,phone-light-zh-TW");
const started = Date.now();
try {
  for (const c of CASES) {
    const cn = caseName(c), phone = c.device === "phone", L = c.lang;
    const { ctx, page } = await fx.page(c, { path: `/ui/chat/${encodeURIComponent(name)}` });
    await page.addInitScript({ content: "window.__name = (f) => f;" });
    if (!phone) await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: fx.base });
    const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
    await page.goto(`${fx.base}/ui/chat/${encodeURIComponent(name)}`);
    await page.waitForSelector(".msg[data-key] .md table", { timeout: 20000 }); await page.waitForTimeout(1000);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    // The table in this case's language, in view.
    const T = `[...document.querySelectorAll(".msg[data-key] .md table")].find((t) => t.textContent.includes(${JSON.stringify(L === "en" ? "Backend" : "後端")}))`;
    await page.evaluate(`(${T}).scrollIntoView({ block: "center" })`); await page.waitForTimeout(300);
    const at = async (row: number, col: number) => page.evaluate(`(() => { const r = (${T}).rows[${row}].cells[${col}].getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`) as Promise<{ x: number; y: number }>;
    const state = () => page.evaluate(`(() => { const t = ${T}; return { sel: [...t.rows].map((tr) => [...tr.cells].map((c) => c.classList.contains("cell-sel") ? 1 : 0).join("")).join("|"),
      on: t.classList.contains("cells-on"), text: String(getSelection()).trim(), pill: !!document.querySelector(".quote-pop") }; })()`) as Promise<any>;
    const drag = async (from: [number, number], to: [number, number], steps = 8) => {
      const a = await at(...from), b = await at(...to);
      await page.mouse.move(a.x - 6, a.y); await page.mouse.down();
      await page.mouse.move(b.x, b.y, { steps }); await page.mouse.up(); await page.waitForTimeout(150);
    };
    // 1: straight down a column (Model, the 4 body rows).
    await drag([1, 1], [4, 1]);
    const col = await state();
    await page.screenshot({ path: shotPath(SMOKE, cn, "1-column") });
    if (phone) {
      check(`${cn}:phone-no-cells`, col.sel === "0000|0000|0000|0000|0000" && !col.on, col);
    } else if (BASELINE) {
      // The base has no cell selection: the drag selects no cells, and Ctrl+C has no column to copy.
      await page.keyboard.press("Control+C"); await page.waitForTimeout(150);
      const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => ""));
      check(`${cn}:baseline-no-cells`, col.sel === "0000|0000|0000|0000|0000" && !col.on && clip !== "opus\nfable\ngemini 3\nsonnet", { col, clip });
    } else {
      check(`${cn}:column`, col.sel === "0000|0100|0100|0100|0100" && col.on && col.text === "", col);
      // Ctrl+C: the cells as TSV.
      await page.keyboard.press("Control+C"); await page.waitForTimeout(150);
      const clip = await page.evaluate(() => navigator.clipboard.readText());
      check(`${cn}:copy-tsv`, clip === "opus\nfable\ngemini 3\nsonnet", clip);
      // 2: diagonally, a block (Agent..Backend × rows 2–3).
      await drag([2, 0], [3, 2]);
      const block = await state();
      await page.screenshot({ path: shotPath(SMOKE, cn, "2-block") });
      check(`${cn}:block`, block.sel === "0000|0000|1110|1110|0000", block);
      await page.keyboard.press("Control+C"); await page.waitForTimeout(150);
      const clip2 = await page.evaluate(() => navigator.clipboard.readText());
      check(`${cn}:copy-block-tsv`, clip2 === "Lumen\tfable\tclaude-code\nArgon\tgemini 3\tagy", clip2);
      // 3: Esc clears.
      await page.keyboard.press("Escape"); await page.waitForTimeout(100);
      const cleared = await state();
      check(`${cn}:esc-clears`, cleared.sel === "0000|0000|0000|0000|0000" && !cleared.on, cleared);
      // 4: inside one cell: the browser's own text selection, with 「引用」.
      const cell = await page.evaluate(`(() => { const r = (${T}).rows[3].cells[2].getBoundingClientRect(); return { l: r.left, r: r.right, y: r.top + r.height / 2 }; })()`) as any;
      await page.mouse.move(cell.l + 6, cell.y); await page.mouse.down(); await page.mouse.move(cell.r - 6, cell.y, { steps: 6 }); await page.mouse.up();
      await page.waitForTimeout(400);
      const inCell = await state();
      await page.screenshot({ path: shotPath(SMOKE, cn, "3-in-one-cell-quote") });
      check(`${cn}:one-cell-native-quote`, inCell.sel === "0000|0000|0000|0000|0000" && inCell.text.length > 0 && inCell.pill, inCell);
      // 5: a press elsewhere clears a cell selection; the message menu still opens (right-click).
      await drag([1, 3], [4, 3]);
      const p = await page.evaluate(`(() => { const r = (${T}).closest(".msg").querySelector(".md p").getBoundingClientRect(); return { x: r.left + 10, y: r.top + r.height / 2 }; })()`) as any;
      await page.mouse.click(p.x, p.y, { button: "right" }); await page.waitForTimeout(300);
      const menu = await page.evaluate(() => [...document.querySelectorAll(".msg-menu button")].map((b) => (b.textContent || "").trim()));
      const afterMenu = await state();
      await page.screenshot({ path: shotPath(SMOKE, cn, "4-menu") });
      check(`${cn}:press-elsewhere-clears+menu`, afterMenu.sel === "0000|0000|0000|0000|0000" && menu.length >= 2, { afterMenu, menu });
      await page.keyboard.press("Escape");
    }
    check(`${cn}:no-page-errors`, errs.length === 0, errs);
    await ctx.close();
  }
} catch (e) {
  fail.push("error"); r.error = String((e as Error).stack ?? e).slice(0, 1500);
} finally {
  r.seconds = Math.round((Date.now() - started) / 1000);
  writeFileSync(join(OUT, "result.json"), JSON.stringify(r, null, 1));
  for (const f of fail.slice(0, 30)) console.log(`FAIL ${f}: ${JSON.stringify((r[f] as any)?.FAIL ?? r.error ?? "").slice(0, 700)}`);
  console.log(fail.length ? `M-3326 smoke FAILED (${fail.length}) in ${r.seconds}s — ${OUT}` : `M-3326 smoke passed in ${r.seconds}s (${Object.keys(r).length - 2} checks)`);
  await fx.close();
  process.exit(fail.length ? 1 : 0);
}
