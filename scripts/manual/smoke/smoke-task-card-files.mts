// a task card as the person reads it — what an agent wrote on it. ONE script for both builds:
//   ROLE=before  on the release this PR is based on (a card whose agents wrote only what they could: text, a path)
//   ROLE=after   on this PR (the same words as Markdown, and the files the agents attached)
// A typical team job: a main task with three sub tasks — planner's design document, dev's HTML prototype, master's
// acceptance — on the real Tasks tab, desk 1366 / phone 390, light / dark, English / zh-TW (MATRIX=full, the default).
//   PW_DIR=<dir with playwright-core> REPO=<checkout> OUT=<dir> ROLE=before|after FONTCONFIG_FILE=/etc/fonts/fonts.conf \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-task-card-files.mts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PICTURES, bootFixture, caseName, matrix, shotPath, VIEWPORTS } from "../smoke-fixture/index.mts";

const ROLE = process.env.ROLE === "before" ? "before" : "after";
const SMOKE = `smoke-task-card-${ROLE}`;
const roster = ["planner", "dev", "mastertest"].map((name) => ({ name, backend: "claude-code" as const, displayName: name }));
const fx = await bootFixture({ port: Number(process.env.HP ?? 48560), instances: 3, roster, classic: false });
const REPO = process.env.REPO!;
const { SchedulerDb } = await import(REPO + "/src/scheduler/db.ts");
const db = new SchedulerDb(join(fx.dir, "scheduler.db"));
fx.fm.scheduler = { db };
fx.fm.attachTaskBoard(db);
const PERSON = { kind: "person" as const, name: "admin" };
const as = (name: string) => ({ kind: "instance" as const, name });

const DESIGN_MD = "# 倖存者遊戲設計文件 / Survivors design\n\n## 核心循環 / Core loop\n\n1. 移動、自動攻擊\n2. 撿經驗球升級\n3. 三選一升級\n\n## 內容 / Content\n\n| 項目 | 數量 |\n|---|---|\n| 敵人 | 8 + Boss |\n| 武器 | 8 |\n| 被動 | 10 |\n\n```text\n勝利條件：存活 15 分鐘\n```\n";
const GAME_HTML = "<!doctype html><meta charset=utf-8><title>Survivors</title><style>html,body{margin:0;height:100%;background:#111;color:#eee;font:16px sans-serif}canvas{display:block;width:100%;height:100%}</style><canvas id=c width=640 height=400></canvas><script>const g=document.getElementById('c').getContext('2d');g.fillStyle='#5af';g.fillRect(310,190,20,20);g.fillStyle='#f65';for(let i=0;i<14;i++)g.fillRect(40+i*40,60+(i%5)*55,14,14);g.fillStyle='#eee';g.font='16px sans-serif';g.fillText('WASD 移動 · 空白鍵衝刺',200,24);</script>";
// A picture the fixture draws (a real PNG).
const PNG = await fx.picture(Object.keys(PICTURES)[0] as keyof typeof PICTURES);

const staged = async (who: string, name: string, bytes: Buffer): Promise<string> => {
  const { stageFile } = await import(REPO + "/src/task-attach-client.ts");
  const { boardToolAction } = await import(REPO + "/src/task-board-tool.ts");
  const got = await stageFile(name, bytes, async (call: any) => { try { return { result: boardToolAction(db, who, call) }; } catch (e) { return { error: (e as Error).message }; } });
  if ("error" in got) throw new Error(got.error);
  return got.upload;
};

db.board.createProject(PERSON, { name: "遊戲 Games" });
const mains = db.board.createCards(PERSON, { project: "遊戲 Games", cards: [{ title: "製作倖存者遊戲", assignee: "mastertest", dispatcher: { kind: "person" },
  goal: "製作一款倖存者類（Survivors-like）遊戲。\n\n- master 統籌與整合\n- planner 負責企劃，dev 負責程式\n- 子任務由不同 agent 處理並回報到本主任務",
  acceptance: ["企劃文件完成（玩法、敵人、武器、升級、勝負條件）", "可執行的原型完成", "master 整合並驗收"] }] }).cards;
const M = mains[0]!.code;
const subs = db.board.createCards(PERSON, { cards: [
  { parent: M, title: "企劃：倖存者遊戲設計文件", assignee: "planner", goal: "撰寫設計文件，完成後回報到主任務。" },
  { parent: M, title: "程式：倖存者遊戲原型實作", assignee: "dev", goal: "做一個可在瀏覽器直接開啟的 HTML 原型。" },
  { parent: M, title: "Master：整合與驗收", assignee: "mastertest", goal: "彙整企劃與程式成果，驗收原型並回報使用者。" },
] }).cards;
const [S1, S2, S3] = subs.map((c: any) => c.code);

// planner: S-1
db.board.moveCard(as("planner"), S1, "claimed", {});
const design = ROLE === "after" ? await staged("planner", "survivor-design.md", Buffer.from(DESIGN_MD)) : null;
if (ROLE === "after") {
  db.board.moveCard(as("planner"), S1, "done", {
    result: "## 設計文件完成\n\n核心循環、操作、**8 種敵人 + Boss**、8 武器、10 被動、升級規則、勝負條件、MVP 範圍。\n\n驗證：逐項對照主任務的企劃清單。",
    comment: "## S-1 完成：設計文件\n\n**核心循環**\n\n1. 移動、自動攻擊\n2. 撿經驗球升級\n3. 三選一升級\n\n**MVP 範圍**：1 張地圖、3 種武器、3 種敵人，存活 15 分鐘獲勝。\n\n完整文件見附件 `survivor-design.md`。",
    attach: [design!] });
} else {
  db.board.moveCard(as("planner"), S1, "done", { result: "設計文件完成：/data/workspaces/planner/survivor-design.md（核心循環、操作、8種敵人+Boss、波次表、8武器、10被動、升級規則、數值目標、勝負條件、MVP範圍）" });
  db.board.updateCard(as("planner"), S1, { comment: "S-1 完成。設計文件路徑：/data/workspaces/planner/survivor-design.md（含 MVP 範圍建議）" });
}
// dev: S-2
db.board.moveCard(as("dev"), S2, "claimed", {});
if (ROLE === "after") {
  const game = await staged("dev", "survivor.html", Buffer.from(GAME_HTML));
  const shot = await staged("dev", "screenshot.png", PNG);
  db.board.moveCard(as("dev"), S2, "done", {
    result: "可執行原型：單檔 HTML5 Canvas，瀏覽器直接開啟。WASD 移動、空白鍵衝刺、3 種武器、3 種敵人、三選一升級、存活 15 分鐘獲勝。",
    comment: "## S-2 完成：可玩原型\n\n**這是什麼**：一個單檔的網頁小遊戲（CSS、JS 都內嵌）。\n\n**怎麼打開**：下載附件 `survivor.html` 用瀏覽器開啟就能玩，或在這張卡的檔案區按 **預覽**。\n\n測試參數（加在網址後）：`?speed=2`、`?win=10`。",
    attach: [game, shot] });
} else {
  db.board.moveCard(as("dev"), S2, "done", { result: "可執行原型：/data/dev/survivors/index.html（單檔 HTML5 Canvas，瀏覽器直接開啟）。WASD 移動、空白鍵衝刺、3 種武器、3 種敵人、三選一升級、存活 15 分鐘獲勝" });
}
// master: S-3 and the main task's own words
db.board.moveCard(as("mastertest"), S3, "claimed", {});
db.board.moveCard(as("mastertest"), S3, "done", { result: ROLE === "after" ? "## 驗收通過\n\n- `survivor.html` 存在，JS 語法檢查通過\n- 內容符合企劃的 MVP 範圍" : "驗收：index.html 存在（322 行），JS 語法檢查通過；內容符合企劃 MVP 範圍。" });
db.board.updateCard(as("mastertest"), M, { state: ROLE === "after" ? "- 企劃 ✅\n- 原型 ✅\n- 驗收 ✅\n\n下一步：等你確認" : "企劃、原型、驗收都完成，等你確認" });

const results: any = { role: ROLE, browser: fx.browser.version(), card: M, shots: [] as string[], checks: [] as Array<{ case: string; name: string; ok: boolean; detail?: unknown }> };
const check = (c: string, name: string, ok: boolean, detail?: unknown) => { results.checks.push({ case: c, name, ok, ...(detail !== undefined ? { detail } : {}) }); };

/** In the page: does the Edit button cover any line of the field's text, and how big is it? (text nodes' line boxes, not the blocks' own boxes) */
const EDIT_PROBE = `(() => {
  const md = document.querySelector(".tp-body .tc-md-wrap .tc-md"), btn = document.querySelector(".tp-body .tc-md-wrap .tc-md-edit");
  if (!md || !btn) return null;
  const b = btn.getBoundingClientRect(), cs = getComputedStyle(btn), lines = [];
  const walk = document.createTreeWalker(md, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) { if (!n.textContent.trim()) continue; const r = document.createRange(); r.selectNodeContents(n); lines.push(...r.getClientRects()); }
  const hit = lines.some((l) => l.width > 0 && l.height > 0 && l.left < b.right && l.right > b.left && l.top < b.bottom && l.bottom > b.top);
  const bottom = Math.max(...lines.map((l) => l.bottom));
  return { w: Math.round(b.width), h: Math.round(b.height), position: cs.position, covers: hit, belowText: b.top >= bottom - 1 };
})()`;
/** The smallest box among each selector's matches (a phone control is a 44px tap box), and how many there are. */
const TAP_PROBE = (sels: string[]) => `(() => Object.fromEntries(${JSON.stringify(sels)}.map((s) => { const all = [...document.querySelectorAll(s)].map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0); return [s, { n: all.length, minH: all.length ? Math.round(Math.min(...all.map((r) => r.height))) : 0 }]; })))()`;

for (const c of matrix()) {
  const name = caseName(c);
  // This device allows previews (the host preference the chat's own opt-in writes).
  const { page, ctx } = await fx.page(c, { path: `/ui/fleet?card=${S1}`, prefs: { "preview.optIn": true } });
  await page.setViewportSize({ width: VIEWPORTS[c.device].width, height: c.device === "phone" ? 1900 : 1250 });
  await page.waitForSelector(".tp", { timeout: 15000 });
  await page.waitForTimeout(600);
  const file = shotPath(SMOKE, c, "planner-card");
  await page.screenshot({ path: file, fullPage: true });
  results.shots.push(file);
  if (ROLE === "before") {
    // The same developer's card, for the pair: what the card showed before — a result that is a path, nothing to open.
    await page.goto(`${fx.base}/ui/fleet?card=${S2}`); await page.waitForSelector(".tp", { timeout: 15000 }); await page.waitForTimeout(600);
    const dev = shotPath(SMOKE, c, "dev-card");
    await page.screenshot({ path: dev, fullPage: true });
    results.shots.push(dev);
  }
  if (ROLE === "after") {
    // The planner's card: Markdown in its fields, its file under the comment and in the Files field, the Edit button.
    if (c.device === "desk") { await page.hover(".tp-body .tc-md-wrap"); await page.waitForTimeout(150); }
    const edit: any = await page.evaluate(EDIT_PROBE);
    check(name, "the Markdown fields are drawn (an Edit button on each)", !!edit, edit);
    if (edit) {
      check(name, "the Edit button covers no text", edit.covers === false, edit);
      if (c.device === "phone") check(name, "phone: the Edit button is a row under the text, a 44px box", edit.position === "static" && edit.belowText && edit.h >= 44 && edit.w >= 44, edit);
    }
    check(name, "the file is under the comment and in the Files field", (await page.locator(".tl-comment .tf-row").count()) >= 1 && (await page.locator(".tp-files .tf-row").count()) === 1);
    if (c.device === "phone") {
      const taps: any = await page.evaluate(TAP_PROBE([".tf-dl", ".tf-text .btn"]));
      check(name, "phone: Download and Show are 44px boxes", Object.values(taps).every((t: any) => t.n > 0 && t.minH >= 44), taps);
    }
    // The developer's card: the one-file prototype, run from the card in a box of its own.
    await page.goto(`${fx.base}/ui/fleet?card=${S2}`); await page.waitForSelector(".tp-files", { timeout: 15000 }); await page.waitForTimeout(600);
    const dev = shotPath(SMOKE, c, "dev-card");
    await page.screenshot({ path: dev, fullPage: true });
    results.shots.push(dev);
    if (c.device === "phone") {
      const taps: any = await page.evaluate(TAP_PROBE([".tf-dl", ".tf-actions .btn"]));
      check(name, "phone: Download and Preview are 44px boxes", Object.values(taps).every((t: any) => t.n > 0 && t.minH >= 44), taps);
    }
    // The prototype RUNS from the card: Preview reads the file and starts the sandbox frame — an iframe of the preview origin, scripts only,
    // in a box of fixed height — and the file itself is still a download, never a page of the dashboard.
    await page.click(".tp-files .tf-html .btn-primary");
    await page.waitForSelector(".tp-files iframe", { timeout: 15000 });
    await page.waitForTimeout(1800);
    const frame = page.frames().find((f: any) => f !== page.mainFrame() && f.url().startsWith("http"));
    const box: any = await page.evaluate(`(() => { const f = document.querySelector(".tp-files iframe"), r = f.getBoundingClientRect(); return { h: Math.round(r.height), w: Math.round(r.width), fill: f.classList.contains("fill"), sandbox: f.getAttribute("sandbox") }; })()`);
    const preview = { ...box, origin: frame ? new URL(frame.url()).origin : null, dashboard: fx.base, canvasInFrame: frame ? await frame.locator("canvas").count() : 0 };
    check(name, "the prototype runs in the sandbox frame of the other origin", preview.sandbox === "allow-scripts" && preview.origin !== null && preview.origin !== fx.base && preview.canvasInFrame === 1, preview);
    check(name, "the running preview has a box of its own (not the 40px strip)", preview.fill && preview.h >= 300, preview);
    const run = shotPath(SMOKE, c, "dev-card-preview-running");
    await page.screenshot({ path: run, fullPage: true });
    results.shots.push(run);
    if (name === "desk-light-en") {
      const id = (db.board.attachments(db.board.getCard(S2).uuid) as any[]).find((f) => f.name === "survivor.html").id;
      const dl = await page.request.get(`${fx.base}/ui/tasks/files/${id}`);
      results.download = { status: dl.status(), type: dl.headers()["content-type"], disposition: dl.headers()["content-disposition"], csp: dl.headers()["content-security-policy"] };
      check(name, "the file itself is a download, not a page", dl.status() === 200 && dl.headers()["content-type"] === "application/octet-stream" && /^attachment/.test(dl.headers()["content-disposition"] ?? ""), results.download);
    }
  }
  await ctx.close();
}
const failed = results.checks.filter((k: any) => !k.ok);
writeFileSync(join(process.env.OUT ?? "/tmp", `${SMOKE}-results.json`), JSON.stringify(results, null, 2) + "\n");
console.log(`${ROLE}: ${results.shots.length} screenshots, ${results.checks.length - failed.length}/${results.checks.length} checks pass`);
for (const k of failed) console.log("FAIL", k.case, k.name, JSON.stringify(k.detail));
await fx.close();
process.exit(failed.length ? 1 : 0);
