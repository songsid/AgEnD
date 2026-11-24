/**
 * M-3668 real-app captures: finished work on the Tasks page — the Done column's newest 20 and "Show 20 more", this week's
 * count, the Archive list, a project tile's archived count, search's and a card's "Archived". The real web app and task
 * board (scripts/manual/smoke-fixture, a scratch scheduler database of made-up cards); no fleet, CLI or account.
 *   REPO=<checkout> PW_DIR=<playwright-core root> OUT=<dir> npx tsx scripts/manual/task-board-archive-m3668/capture.mts
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture } from "../smoke-fixture/index.mts";

const OUT = process.env.OUT!, REPO = process.env.REPO!;
mkdirSync(OUT, { recursive: true });
const git = (...a: string[]) => execFileSync("git", ["-C", REPO, "-c", "gc.auto=0", ...a], { encoding: "utf8" }).trim();
const receipt: any = { sourceHead: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain", "--", "src").split("\n").filter(Boolean), checks: [], pictures: [] };
const check = (name: string, ok: unknown, detail?: unknown) => { receipt.checks.push({ name, ok: !!ok, ...(ok ? {} : { detail }) }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail)}`}`); };
const fx = await bootFixture({ port: 0, instances: 3, classic: false });
try {
  const { Scheduler, DEFAULT_SCHEDULER_CONFIG } = await import(REPO + "/src/scheduler/index.ts");
  const fm = fx.fm;
  fm.scheduler?.db.close();
  fm.scheduler = new Scheduler(join(fm.dataDir, "archive-example.db"), () => {}, DEFAULT_SCHEDULER_CONFIG, () => true);
  fm.attachTaskBoard(fm.scheduler.db);
  const board = fm.scheduler.db.board, db = (board as any).db;
  const person = { kind: "person", name: "Example owner" } as const;
  const names = fx.instances.map((i: any) => i.name);
  const project = board.createProject(person, { name: "Example project" });
  // 60 main tasks finished over the last 11 days (a few cancelled), and some at work.
  for (let i = 0; i < 60; i++) {
    const c = board.createCards(person, { cards: [{ title: `Example task ${i + 1} · 示範任務 ${i + 1}`, assignee: names[i % names.length], project: project.id }] }).cards[0];
    const cancel = i % 13 === 7;
    board.moveCard(person, c.code, cancel ? "cancelled" : "done", cancel ? { reason: "Not needed" } : { result: "Done." });
    // 40 in the last 3 days (more than the Done column's 20), the rest from 80 hours to 11 days ago (archived).
    const at = new Date(Date.now() - (i < 40 ? i * 1.5 + 1 : 80 + (i - 40) * 10) * 3_600_000).toISOString();
    db.prepare("UPDATE tasks SET done_at = ?, updated_at = ? WHERE code = ?").run(cancel ? null : at, at, c.code);
  }
  for (const [title, to] of [["Plan the next release · 規劃下一版", "claimed"], ["Fix the sign-in page · 修登入頁", "blocked"], ["Write the guide · 寫說明", "open"]] as const) {
    const c = board.createCards(person, { cards: [{ title, assignee: names[0], project: project.id }] }).cards[0];
    if (to !== "open") board.moveCard(person, c.code, to, to === "blocked" ? { reason: "Waiting for the design" } : {});
  }
  const stats = board.projectStats(undefined, 3)[String(project.id)];
  receipt.board = { archived: stats.archived, doneWeek: stats.doneWeek, mains: stats.mains };
  check("the board's numbers: archived and this week's are counted", stats.archived > 20 && stats.doneWeek > 20, stats);
  const archivedOne = board.archiveList(project.id, 3, { limit: 1 }).cards[0];
  for (const c of [{ device: "desk", theme: "light", lang: "en" }, { device: "desk", theme: "dark", lang: "zh-TW" }, { device: "phone", theme: "light", lang: "en" }, { device: "phone", theme: "dark", lang: "zh-TW" }] as const) {
    const p = await fx.page(c), page = p.page, tag = `${c.device}-${c.lang}-${c.theme}`, phone = c.device === "phone", errors: string[] = [];
    await page.emulateMedia({ reducedMotion: "reduce" });
    page.on("pageerror", (e: Error) => errors.push(e.message));
    const shot = async (name: string) => { await page.waitForTimeout(400); const path = `m3668-${tag}-${name}.png`; await page.screenshot({ path: join(OUT, path) }); receipt.pictures.push({ path, sha256: createHash("sha256").update(readFileSync(join(OUT, path))).digest("hex") }); };
    // Home: the project's tile says how many are archived.
    await page.goto(fx.base + "/ui/fleet/tasks"); await page.locator(".tb").waitFor(); await page.waitForTimeout(1500);
    const tile = await page.locator(".tb-project-archived").first().innerText().catch(() => "");
    check(`${tag}: the project tile says how many are archived`, new RegExp(String(stats.archived)).test(tile), tile);
    await shot("1-home");
    // The project's board: the Done column's newest 20, this week's count, "Archived · N".
    await page.goto(fx.base + `/ui/fleet/tasks?tp=${project.id}`); await page.locator(".tb-board-page").waitFor(); await page.waitForTimeout(1500);
    if (phone) { await page.locator(".tb-status-seg .tb-seg-btn", { hasText: c.lang === "en" ? "Done" : "完成" }).first().click().catch(() => {}); await page.waitForTimeout(600); }
    const done = await page.locator('.tb-col.st-done .tb-tile').count();
    const week = await page.locator(".tb-done-week").first().innerText().catch(() => "");
    const link = await page.locator(".tb-archived-link").first().innerText().catch(() => "");
    check(`${tag}: the Done column shows its newest 20`, done === 20, done);
    check(`${tag}: its header says this week's count`, new RegExp(String(stats.doneWeek)).test(week), week);
    check(`${tag}: the board's header has "Archived · ${stats.archived}"`, new RegExp(String(stats.archived)).test(link), link);
    await shot("2-board");
    await page.locator(".tb-done-more").first().scrollIntoViewIfNeeded(); await shot("2b-show-more");
    await page.locator(".tb-done-more").first().click(); await page.waitForTimeout(600);
    check(`${tag}: "Show 20 more" shows the next 20`, (await page.locator('.tb-col.st-done .tb-tile').count()) > 20);
    // The Archive list.
    await page.locator(".tb-archived-link").first().click(); await page.locator(".tb-archive .tb-row").first().waitFor(); await page.waitForTimeout(800);
    const rows = await page.locator(".tb-archive .tb-row").count();
    check(`${tag}: the Archive lists the archived cards, newest first`, rows > 0 && (await page.locator(".tb-archive .tb-row-main").first().innerText()) === archivedOne.code, rows);
    await shot("3-archive");
    await page.keyboard.press("Escape"); await page.waitForTimeout(400);
    // Search marks an archived card; its page says so too.
    await page.goto(fx.base + "/ui/fleet/tasks"); await page.locator(".tb-search input").waitFor();
    await page.locator(".tb-search input").fill(archivedOne.code); await page.waitForTimeout(900);
    const hit = await page.locator(".tb-search-results li").first().innerText().catch(() => "");
    check(`${tag}: search marks an archived card`, /Archived|已封存/.test(hit), hit);
    await shot("4-search");
    await page.goto(fx.base + `/ui/fleet/tasks?card=${archivedOne.code}`); await page.locator(".tp-idrow").waitFor(); await page.waitForTimeout(800);
    check(`${tag}: its page says Archived`, /Archived|已封存/.test(await page.locator(".tp-idrow").innerText()));
    await shot("5-card");
    check(`${tag}: no page errors`, errors.length === 0, errors);
    await page.context().close();
  }
} finally {
  await fx.close();
  const failed = receipt.checks.filter((x: any) => !x.ok).length;
  receipt.summary = `${receipt.checks.length - failed}/${receipt.checks.length}`;
  writeFileSync(join(OUT, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(`checks ${receipt.summary}`);
  process.exitCode = failed ? 1 : 0;
}
