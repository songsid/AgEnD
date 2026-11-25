/**
 * M-3668 real-app captures: finished work on the Tasks page — the Done column's newest 20 and "Show 20 more", this week's
 * count, the Archive list, a project tile's archived count, search's and a card's "Archived", and (#4428 review) the
 * Settings control for the archive age and an archived main task's sub task leaving the board with it. The real web app and task
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
  // 120 main tasks finished over the last 4 weeks (a few cancelled), and some at work.
  for (let i = 0; i < 120; i++) {
    const c = board.createCards(person, { cards: [{ title: `Example task ${i + 1} · 示範任務 ${i + 1}`, assignee: names[i % names.length], project: project.id }] }).cards[0];
    const cancel = i % 13 === 7;
    board.moveCard(person, c.code, cancel ? "cancelled" : "done", cancel ? { reason: "Not needed" } : { result: "Done." });
    // 40 in the last 3 days (more than the Done column's 20), the rest from 80 hours to 4 weeks ago (archived: more than
    // the Archive's page of 50).
    const at = new Date(Date.now() - (i < 40 ? i * 1.5 + 1 : 80 + (i - 40) * 7.5) * 3_600_000).toISOString();
    db.prepare("UPDATE tasks SET done_at = ?, updated_at = ? WHERE code = ?").run(cancel ? null : at, at, c.code);
  }
  for (const [title, to] of [["Plan the next release · 規劃下一版", "claimed"], ["Fix the sign-in page · 修登入頁", "blocked"], ["Write the guide · 寫說明", "open"]] as const) {
    const c = board.createCards(person, { cards: [{ title, assignee: names[0], project: project.id }] }).cards[0];
    if (to !== "open") board.moveCard(person, c.code, to, to === "blocked" ? { reason: "Waiting for the design" } : {});
  }
  // #4428 review: an archived main task's sub task, finished more recently, leaves the board with it.
  // The oldest archived one (each combination reopens the newest).
  const oldMain = board.archiveList(project.id, 3, { limit: 100 }).cards.at(-1);
  const lateStep = board.createCards(person, { cards: [{ parent: oldMain.code, title: "A late step · 晚完成的步驟", assignee: names[0] }] }).cards[0];
  db.prepare("UPDATE tasks SET status = 'done', done_at = ?, updated_at = ? WHERE code = ?").run(new Date(Date.now() - 3_600_000).toISOString(), new Date(Date.now() - 3_600_000).toISOString(), lateStep.code);
  // A new step reopens its main task: put the main task back as it was (finished, archived), as the review's database had it.
  db.prepare("UPDATE tasks SET status = ?, done_at = ?, updated_at = ? WHERE code = ?").run(oldMain.status, oldMain.doneAt, oldMain.updatedAt, oldMain.code);
  if (!board.isArchived(board.getCard(lateStep.code), 3)) throw new Error("fixture: the late step's main task is not archived");
  const first = board.projectStats(undefined, 3)[String(project.id)];
  receipt.board = { archived: first.archived, doneWeek: first.doneWeek, archivedWeek: first.archivedWeek, mains: first.mains };
  check("the board's numbers: archived (more than a page of 50) and this week's are counted", first.archived > 50 && first.doneWeek > 20 && first.archivedWeek > 0, first);
  // Which finished cards are cancelled (not in the Done column): the captures' numbering skips them.
  receipt.cancelledInDoneRange = db.prepare("SELECT code FROM tasks WHERE status = 'cancelled' ORDER BY sort").all().map((r: any) => r.code);
  for (const c of [{ device: "desk", theme: "light", lang: "en" }, { device: "desk", theme: "dark", lang: "zh-TW" }, { device: "phone", theme: "light", lang: "en" }, { device: "phone", theme: "dark", lang: "zh-TW" }] as const) {
    // Each combination reopens one archived card: its numbers are read afresh.
    const stats = board.projectStats(undefined, 3)[String(project.id)];
    const [archivedOne, archivedTwo] = board.archiveList(project.id, 3, { limit: 2 }).cards;   // the first is reopened below
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
    check(`${tag}: its header says this week's count and how many of them are archived`, new RegExp(`${stats.doneWeek}\\D.*${stats.archivedWeek}`).test(week) && /done this week|本週完成/i.test(week), week);
    check(`${tag}: the board's header has "Archived · ${stats.archived}"`, new RegExp(String(stats.archived)).test(link), link);
    // A desk's five columns scroll sideways: the Done column brought into view (its head says this week's count).
    if (!phone) { await page.evaluate(() => { const s = document.querySelector(".tb-scroll") as HTMLElement | null; if (s) s.scrollLeft = s.scrollWidth; }); await page.waitForTimeout(400); }
    check(`${tag}: this week's count stands over the Done cards, outside the column's head`, (await page.locator(".tb-col-head .tb-done-week").count()) === 0) ;
    if (phone) check(`${tag}: on a phone this week's count stands over the Done cards`, new RegExp(String(stats.doneWeek)).test(await page.locator(".tb-done-week-line").first().innerText().catch(() => "")));
    // The project's name is not squeezed by the header's links (it stays on one line).
    const nameLines = await page.evaluate(() => { const h = document.querySelector(".tb-name h2") as HTMLElement | null; if (!h) return 0; const lh = parseFloat(getComputedStyle(h).lineHeight) || 24; return Math.round(h.getBoundingClientRect().height / lh); });
    // Measured, not checked: on a phone the release's own head squeezes a project's name beside its buttons (as before M-3668).
    (receipt.measured ??= {})[`${tag}-nameLines`] = nameLines;
    await shot("2-board");
    // "Show N more": a before/after pair — the button and the last cards before, the appended cards after.
    const more = page.locator(".tb-done-more").first();
    const moreBefore = await more.innerText();
    await more.scrollIntoViewIfNeeded(); await shot("2b-show-more-before");
    await more.click(); await page.waitForTimeout(700);
    const after = await page.locator('.tb-col.st-done .tb-tile').count();
    const left = await page.locator(".tb-done-more").count();
    check(`${tag}: "${moreBefore}" appends the rest`, after > 20 && after === done + Number((moreBefore.match(/\d+/) || ["0"])[0]) && left === 0, { moreBefore, after, left });
    // The join in one frame: the 20th card (the old last) and the first appended ones under it.
    await page.locator('.tb-col.st-done .tb-tile').nth(19).evaluate((el: HTMLElement) => el.scrollIntoView({ block: "start" })); await shot("2c-show-more-after");
    // The Archive list.
    await page.locator(".tb-archived-link").first().click(); await page.locator(".tb-archive .tb-row").first().waitFor(); await page.waitForTimeout(800);
    const rows = await page.locator(".tb-archive .tb-row").count();
    check(`${tag}: the Archive lists the archived cards, newest first, a page of 50`, rows === 50 && (await page.locator(".tb-archive .tb-row-main").first().innerText()) === archivedOne.code, rows);
    check(`${tag}: the Archive's rows say when, as a date and time`, !/ago|前/.test(await page.locator(".tb-archive .tb-row-time").first().innerText()));
    await shot("3-archive");
    // Its next page.
    await page.locator(".tb-archive .btn", { hasText: c.lang === "en" ? "Show more" : "顯示更多" }).first().click(); await page.waitForTimeout(800);
    const all = await page.locator(".tb-archive .tb-row").count();
    check(`${tag}: "Show more" reads the next page`, all === stats.archived, { all, archived: stats.archived });
    await page.locator(".tb-archive .tb-row").last().scrollIntoViewIfNeeded(); await shot("3b-archive-next-page");
    // An assignee filter.
    const who = names[1];
    await page.locator(".tb-archive select.tb-select").selectOption(who); await page.waitForTimeout(800);
    const whoRows = await page.locator(".tb-archive .tb-row").count();
    const whoNames = await page.locator(".tb-archive .tb-row-who").allInnerTexts();
    check(`${tag}: the assignee filter lists only that agent's`, whoRows > 0 && whoRows < all && whoNames.every((n: string) => n.trim() === whoNames[0]!.trim()), { whoRows, sample: whoNames.slice(0, 3) });
    await shot("3c-archive-filtered");
    // A card opened from the Archive, then reopened: it is back on the board.
    await page.locator(".tb-archive select.tb-select").selectOption(""); await page.waitForTimeout(800);
    await page.locator(".tb-archive .tb-row-title").first().click(); await page.locator(".tp-idrow").waitFor(); await page.waitForTimeout(600);
    await page.locator("button", { hasText: c.lang === "en" ? "Reopen" : "重新開啟" }).first().click(); await page.waitForTimeout(1200);
    const reopened = board.getCard(archivedOne.code);
    check(`${tag}: a card reopened from the Archive is live again and no longer archived`, reopened.status !== "done" && reopened.status !== "cancelled" && !board.isArchived(reopened, 3), reopened.status);
    await shot("7-reopened");
    await page.goto(fx.base + `/ui/fleet/tasks?tp=${project.id}`); await page.locator(".tb-board-page").waitFor(); await page.waitForTimeout(1500);
    const link2 = await page.locator(".tb-archived-link").first().innerText().catch(() => "");
    check(`${tag}: the board counts one archived card fewer`, new RegExp(String(stats.archived - 1)).test(link2), link2);
    // Search marks an archived card; its page says so too.
    await page.goto(fx.base + "/ui/fleet/tasks"); await page.locator(".tb-search input").waitFor();
    await page.locator(".tb-search input").fill(archivedTwo.code); await page.waitForTimeout(900);
    const hit = await page.locator(".tb-search-results li").first().innerText().catch(() => "");
    check(`${tag}: search marks an archived card`, /Archived|已封存/.test(hit), hit);
    await shot("4-search");
    await page.goto(fx.base + `/ui/fleet/tasks?card=${archivedTwo.code}`); await page.locator(".tp-idrow").waitFor(); await page.waitForTimeout(800);
    check(`${tag}: its page says Archived`, /Archived|已封存/.test(await page.locator(".tp-idrow").innerText()));
    await shot("5-card");
    // #4428 review: the board read has no sub task of an archived main task.
    const read = await page.evaluate(async () => (await fetch("/ui/tasks/board", { headers: { "Content-Type": "application/json" } })).json());
    check(`${tag}: the board read leaves out an archived main task's late sub task`, Array.isArray(read.cards) && !read.cards.some((x: any) => x.id === lateStep.code) && typeof read.epoch === "string", read.epoch);
    // #4428 review: Settings → Shared agent settings → Advanced: the archive age (3 unless set), and a bad value refused.
    await page.goto(fx.base + "/settings/agent-defaults"); await page.locator("details.drawer").first().waitFor(); await page.waitForTimeout(1200);
    await page.locator("details.drawer > summary").first().click(); await page.waitForTimeout(500);
    const field = page.locator("#g-archive");
    await field.scrollIntoViewIfNeeded(); await page.evaluate(() => document.querySelector("#g-archive")?.scrollIntoView({ block: "center" })); await page.waitForTimeout(400);
    const label = await field.locator(".s-lab label").innerText().catch(() => "");
    check(`${tag}: Settings has the archive age, 3 unless set`, (await page.locator("#g-archive-days").inputValue()) === "3" && /Archive finished cards after|完成的卡片封存於/.test(label), label);
    // #4428 ui-gate: on a phone the field is a full touch target (44px).
    if (phone) { const box = await page.locator("#g-archive-days").boundingBox(); check(`${tag}: the archive-days field is a 44px tap target`, !!box && box.height >= 44, box); }
    await shot("6-settings");
    await page.locator("#g-archive-days").fill("2.5"); await page.waitForTimeout(500);
    check(`${tag}: Settings refuses a fraction of a day`, /A whole number of days from 0 to 3650|0 到 3650 之間的整數天數/.test(await field.innerText()));
    await shot("6b-settings-refused");
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
