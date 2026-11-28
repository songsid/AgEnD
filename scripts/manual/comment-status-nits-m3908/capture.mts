/**
 * M-3908 real-app captures: a task card's comment status lines (#4573) after the follow-up — a failed delivery says why, 「還有 N 張卡」
 * opens the rest of the unread strip, and the phone layout (gutters, zh words whole in status lines, names whole). The real web app and
 * task board (scripts/manual/smoke-fixture, a scratch scheduler database of made-up cards); no fleet, CLI or account. The delivery
 * outbox's progress is a stub (`fm.taskWakeProgress`) giving each notice its state; what the outbox reads is tested on its own
 * (tests/comment-status-nits-m3908.test.ts).
 *   CHROME=<chromium> PW_DIR=<playwright-core root> REPO=<checkout> OUT=<dir> npx tsx scripts/manual/comment-status-nits-m3908/capture.mts
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture } from "../smoke-fixture/index.mts";

const OUT = process.env.OUT!, REPO = process.env.REPO!;
mkdirSync(OUT, { recursive: true });
const git = (...a: string[]) => execFileSync("git", ["-C", REPO, "-c", "gc.auto=0", ...a], { encoding: "utf8" }).trim();
const receipt: any = { sourceHead: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain", "--", "src").split("\n").filter(Boolean), checks: [], pictures: [], measured: {} };
const check = (name: string, ok: unknown, detail?: unknown) => { receipt.checks.push({ name, ok: !!ok, ...(ok ? {} : { detail }) }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail)}`}`); };
/** What runs into the phone's side gutter: boxes of the page's own content, and every line of on-screen text (a text node's line box, so a
 * button's padding that sits in the gutter on purpose, as the inline title editor's, is not counted — its words start at 16px). */
const GUTTER = `(() => { const vw = document.documentElement.clientWidth, out = [], r = document.createRange();
  const root = document.querySelector("main") || document.body;
  // Not counted: what is out of sight or for a screen reader, and what sits in a strip that scrolls sideways (the Fleet tabs).
  const scrolls = (e) => { for (let a = e; a && a !== root; a = a.parentElement) { const ox = getComputedStyle(a).overflowX; if ((ox === "auto" || ox === "scroll") && a.scrollWidth > a.clientWidth + 1) return true; } return false; };
  const skip = (e) => !e || e.closest(".skip, .sr-only, [inert], [aria-hidden=true], .menu-list, .toasts") || e.getClientRects().length === 0 || e.getBoundingClientRect().width <= 2 || scrolls(e);   // <= 2: a visually hidden label (an icon tab's)
  for (const e of root.querySelectorAll(".tl-card, .tl-line, .tc-composer, .tp-head, .tp-activity, .tb-waiting, .tb-unread-strip, .tb-project")) {
    if (skip(e)) continue; const b = e.getBoundingClientRect(); if (b.right <= 0 || b.left >= vw) continue;
    if (b.left < 16 || vw - b.right < 16) out.push("box " + e.className.split(" ")[0] + " " + Math.round(b.left) + "/" + Math.round(vw - b.right)); }
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let t;
  while ((t = tw.nextNode())) { if (!t.textContent.trim() || skip(t.parentElement)) continue; r.selectNodeContents(t);
    for (const b of r.getClientRects()) { if (!b.width || b.right <= 0 || b.left >= vw) continue;
      if (b.left < 16 || vw - b.right < 16) { out.push("text " + (t.parentElement.className || t.parentElement.tagName) + " " + Math.round(b.left) + "/" + Math.round(vw - b.right) + " " + t.textContent.trim().slice(0, 20)); break; } } }
  return out.slice(0, 20); })()`;
const fx = await bootFixture({ port: 0, instances: 16, classic: false });
try {
  const { Scheduler, DEFAULT_SCHEDULER_CONFIG } = await import(REPO + "/src/scheduler/index.ts");
  const fm = fx.fm;
  fm.scheduler?.db.close();
  fm.scheduler = new Scheduler(join(fm.dataDir, "status-example.db"), () => {}, DEFAULT_SCHEDULER_CONFIG, () => true);
  fm.attachTaskBoard(fm.scheduler.db);
  const board = fm.scheduler.db.board, db = (board as any).db;
  const person = { kind: "person", name: "Example owner" } as const;
  const general = { kind: "instance", name: "general" } as const;
  const byStatus = (s: string) => fx.instances.find((i: any) => i.status === s)!.name;
  const offline = byStatus("crashed"), paused = byStatus("paused");
  const LONG = "synthetic-gateway-worker-for-long-name-layout-probes", CJK = "示範文件撰寫與校對助理-layout-probes";
  const project = board.createProject(person, { name: "Example project" });
  // 1. One card whose comments were written for many instances: every kind of status line, the failures with their reasons.
  const card = board.createCards(person, { cards: [{ title: "Example task · 整理首頁的說明文字", assignee: "general", project: project.id, needsReview: false }] }).cards[0];
  board.moveCard(general, card.code, "claimed");
  const say = (by: any, comment: string) => { board.updateCard(by, card.code, { comment }); return board.detail(card.code).comments.at(-1); };
  const progress = new Map<string, any>();
  const at = new Date(Date.now() - 5 * 60_000).toISOString();
  let n = 0;
  const wakes = (entry: any, list: Array<{ to: string; state: string; failure?: string; consumed?: boolean; skip?: string }>) => {
    const stored = list.map((w) => {
      if (w.skip) return { to: w.to, why: "addressed", skip: w.skip, at };
      const key = `m3908-${++n}`;
      progress.set(key, { target: w.to, state: w.state, createdAt: at, finishedAt: at, consumedAt: w.consumed ? at : null, ...(w.failure ? { failure: w.failure } : {}) });
      return { to: w.to, why: "addressed", key, at };
    });
    db.prepare("UPDATE task_entries SET wakes = ? WHERE id = ?").run(JSON.stringify(stored), entry.id);
  };
  wakes(say(person, "請先看一下首頁那段說明文字，有不清楚的地方再跟我說，謝謝"), [
    { to: "general", state: "failed", failure: "expired" }, { to: LONG, state: "failed", failure: "attempts" }]);
  wakes(say(person, "部署前檢查清單也請一起核對，確認每一項都打勾了嗎？"), [
    { to: "core-dev", state: "failed", failure: "other" }, { to: offline, state: "queued" }, { to: paused, state: "queued" }]);
  wakes(say(person, "效能分析的結果放在卡片附件，請大家有空時看一下。"), [
    { to: "code-reviewer", state: "uncertain" }, { to: "web-preview-bot", state: "x", skip: "board_off" }, { to: CJK, state: "delivered", consumed: true }]);
  fm.taskWakeProgress = (keys: readonly string[]) => new Map(keys.flatMap((k) => (progress.has(k) ? [[k, progress.get(k)]] : [])));
  for (const c of [{ device: "desk", theme: "light", lang: "zh-TW" }, { device: "phone", theme: "dark", lang: "zh-TW" }] as const) {
    const p = await fx.page(c), page = p.page, tag = `${c.device}-${c.theme}-${c.lang}`, phone = c.device === "phone", errors: string[] = [];
    await page.emulateMedia({ reducedMotion: "reduce" });
    page.on("pageerror", (e: Error) => errors.push(e.message));
    const shot = async (name: string) => { await page.waitForTimeout(400); const path = `m3908-${tag}-${name}.png`; await page.screenshot({ path: join(OUT, path) }); receipt.pictures.push({ path, sha256: createHash("sha256").update(readFileSync(join(OUT, path))).digest("hex") }); };
    await page.goto(fx.base + `/ui/fleet/tasks?card=${card.code}`); await page.locator(".tl-wakes").first().waitFor({ timeout: 20000 }); await page.waitForTimeout(1500);
    const lines = await page.locator(".tl-wake").allInnerTexts();
    receipt.measured[`${tag}-lines`] = lines;
    for (const [what, text] of [["expired", `沒有送達 general：它一直無法接收，通知已過期`], ["attempts", `沒有送達 ${LONG}：試了幾次都沒送進去`], ["other", "沒有送達 core-dev：傳進 core-dev 的對話時失敗"]] as const)
      check(`${tag}: a failed delivery says why (${what})`, lines.some((l) => l.trim() === text), lines);
    // Status lines keep zh words whole and every name whole (no ellipsis anywhere in a line).
    const wake = await page.evaluate(`[...document.querySelectorAll(".tl-wake")].map((e) => { const s = getComputedStyle(e.querySelector("span, button") || e); return { wb: s.wordBreak, cut: e.scrollWidth > e.clientWidth + 1, ov: s.textOverflow }; })`) as Array<{ wb: string; cut: boolean; ov: string }>;
    check(`${tag}: status lines keep zh words whole`, wake.length > 0 && wake.every((w) => w.wb === "keep-all"), wake.map((w) => w.wb));
    check(`${tag}: no status line is cut`, wake.every((w) => !w.cut && w.ov !== "ellipsis"), wake);
    const bodies = await page.evaluate(`[...document.querySelectorAll(".tl-comment .tl-body")].map((e) => getComputedStyle(e).wordBreak)`) as string[];
    check(`${tag}: comment bodies keep zh words whole`, bodies.length > 0 && bodies.every((w) => w === "keep-all"), bodies);
    await page.evaluate(`document.querySelector(".tl-wakes").closest(".tl-comment").scrollIntoView({ block: "start" })`); await page.waitForTimeout(300);
    await shot("1-statuses");
    // The phone's side gutter (#4573's user look read the activity panel as touching the edges): at 390, 360 and 358 px, every box of
    // the page's content (<main>) and every line of its text keeps 16px or more on both sides, the whole page measured (below the fold too).
    if (phone) {
      for (const w of [390, 360, 358]) {
        await page.setViewportSize({ width: w, height: 800 }); await page.waitForTimeout(300);
        const bad = await page.evaluate(GUTTER) as string[];
        receipt.measured[`${tag}-card-gutter-${w}`] = bad;
        check(`${tag}: at ${w}px the card page keeps a 16px gutter (boxes and text)`, bad.length === 0, bad);
      }
      await page.setViewportSize({ width: 390, height: 844 });
    }
    check(`${tag}: no page errors`, errors.length === 0, errors);
    await p.ctx.close();
  }
  // 2. Home with seven unread cards: the strip lists five and 「還有 2 張卡」 opens the other two. Each page is its own person (key):
  // the page opens once (its floor), then seven cards get a reply under that person's comment.
  for (const c of [{ device: "desk", theme: "light", lang: "zh-TW" }, { device: "phone", theme: "dark", lang: "zh-TW" }] as const) {
    const p = await fx.page(c), page = p.page, tag = `${c.device}-${c.theme}-${c.lang}`, phone = c.device === "phone", errors: string[] = [];
    await page.emulateMedia({ reducedMotion: "reduce" });
    page.on("pageerror", (e: Error) => errors.push(e.message));
    const shot = async (name: string) => { await page.waitForTimeout(400); const path = `m3908-${tag}-${name}.png`; await page.screenshot({ path: join(OUT, path) }); receipt.pictures.push({ path, sha256: createHash("sha256").update(readFileSync(join(OUT, path))).digest("hex") }); };
    await page.goto(fx.base + "/ui/fleet/tasks"); await page.locator(".tb").waitFor(); await page.waitForTimeout(1500);
    const reader = db.prepare("SELECT person FROM task_reads_floor ORDER BY at DESC LIMIT 1").get()?.person as string | undefined;
    check(`${tag}: the page's person has a floor`, !!reader, reader);
    const me = reader?.startsWith("key:") ? { kind: "person", name: "web-user", key: reader.slice(4) } : { kind: "person", name: (reader || "name:web-user").slice(5) };
    // Whatever an earlier page left unread for this person is read now: the strip holds exactly the seven below.
    for (const row of db.prepare("SELECT code FROM tasks").all() as Array<{ code: string }>) board.markRead(me, row.code);
    const codes: string[] = [];
    for (let i = 0; i < 7; i++) {
      const k = board.createCards(person, { cards: [{ title: `回覆測試 ${i + 1} · 首頁說明第 ${i + 1} 段的用字`, assignee: "general", project: project.id, needsReview: false }] }).cards[0];
      board.updateCard(me, k.code, { comment: "這段可以嗎？" });
      const mine = board.detail(k.code).comments.at(-1);
      board.updateCard(general, k.code, { comment: "可以，已經改好了。", replyTo: mine.id });
      codes.push(k.code);
    }
    await page.goto(fx.base + "/ui/fleet/tasks"); await page.locator(".tb-unread-strip").waitFor({ timeout: 20000 }); await page.waitForTimeout(1200);
    const rows = await page.locator(".tb-unread-strip .tb-unread-row").count();
    const more = page.locator(".tb-unread-strip .tb-unread-more button");
    check(`${tag}: the strip lists five, and 「還有 2 張卡」 is a button`, rows === 5 && (await more.count()) === 1 && (await more.innerText()).trim() === "還有 2 張卡", { rows, more: await more.allInnerTexts() });
    if (phone && await more.count()) { const h = await more.evaluate((e: Element) => Math.round(e.getBoundingClientRect().height)); check(`${tag}: on a phone it is a 44px box`, h >= 44, h); }
    await page.evaluate(`document.querySelector(".tb-unread-strip").scrollIntoView({ block: "start" })`); await page.waitForTimeout(200);
    await shot("2-strip");
    if (phone) for (const w of [390, 360, 358]) {
      await page.setViewportSize({ width: w, height: 800 }); await page.waitForTimeout(300);
      const bad = await page.evaluate(GUTTER) as string[];
      check(`${tag}: at ${w}px Home and the strip keep a 16px gutter (boxes and text)`, bad.length === 0, bad);
    }
    if (phone) await page.setViewportSize({ width: 390, height: 844 });
    if (await more.count()) {   // the release tip's overflow is a plain line: nothing to press (the before set stops here)
      await more.click(); await page.waitForTimeout(400);
      const after = await page.locator(".tb-unread-strip .tb-unread-row").count();
      check(`${tag}: pressed, the strip lists all seven and offers 「收合」`, after === 7 && (await more.innerText()).trim() === "收合" && (await more.getAttribute("aria-expanded")) === "true", { after, label: await more.innerText() });
      await shot("3-strip-all");
      // The last of the seven opens its card, as the first five do.
      await page.locator(".tb-unread-strip .tb-unread-row").last().locator(".tb-wait-title").click(); await page.waitForTimeout(1200);
      check(`${tag}: a card listed after 「還有 2 張卡」 opens`, new URL(page.url()).searchParams.get("card") === codes[0], page.url());
    }
    check(`${tag}: no page errors`, errors.length === 0, errors);
    await p.ctx.close();
  }
} finally {
  await fx.close();
  const failed = receipt.checks.filter((x: any) => !x.ok).length; receipt.summary = `${receipt.checks.length - failed}/${receipt.checks.length}`;
  writeFileSync(join(OUT, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n"); console.log(`checks ${receipt.summary}`); process.exitCode = failed ? 1 : 0;
}
