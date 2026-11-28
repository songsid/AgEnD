/**
 * M-3905 real-app captures: a task card's comment threads (#4569) after the zh wording and phone layout pass — the stream
 * (an agent's comment and replies), a comment's ⋯ menu, and who the comment is for (the chip's list). The real web app and
 * task board (scripts/manual/smoke-fixture, a scratch scheduler database of made-up cards); no fleet, CLI or account.
 *   CHROME=<chromium> PW_DIR=<playwright-core root> REPO=<checkout> OUT=<dir> npx tsx scripts/manual/task-thread-nits-m3905/capture.mts
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
const fx = await bootFixture({ port: 0, instances: 6, classic: false });
try {
  const { Scheduler, DEFAULT_SCHEDULER_CONFIG } = await import(REPO + "/src/scheduler/index.ts");
  const fm = fx.fm;
  fm.scheduler?.db.close();
  fm.scheduler = new Scheduler(join(fm.dataDir, "threads-example.db"), () => {}, DEFAULT_SCHEDULER_CONFIG, () => true);
  fm.attachTaskBoard(fm.scheduler.db);
  const board = fm.scheduler.db.board;
  const person = { kind: "person", name: "Example owner" } as const;
  const general = { kind: "instance", name: "general" } as const;
  const project = board.createProject(person, { name: "Example project" });
  const card = board.createCards(person, { cards: [{ title: "Example task · 整理首頁的說明文字", assignee: "general", project: project.id, needsReview: false }] }).cards[0];
  board.moveCard(general, card.code, "claimed");
  const say = (by: any, comment: string, extra: Record<string, unknown> = {}) => { board.updateCard(by, card.code, { comment, ...extra }); return board.detail(card.code).comments.at(-1); };
  // The words of the user look: a question whose 「嗎？」 tail fell on a line of its own, and 「謝謝」 broken inside it.
  const q = say(person, "首頁那段說明我改短了一點，標題也換成比較口語的寫法，你看這樣可以嗎？");
  say(general, "看過了，這樣讀起來順很多，標題我也覺得比較好懂。我把另外兩頁的說明一起改成同樣的語氣，謝謝", { replyTo: q.id });
  // An edited reply: its head carries "edited" too, the widest head the stream draws.
  const r1 = board.detail(card.code).comments.at(-1);
  board.editComment(general, card.code, r1.id, r1.text.replace("順很多", "順多了"));
  say(person, "好，那就照這樣改（已補充）。", { replyTo: q.id });
  board.react(person, card.code, q.id, "👍", true);
  say(general, "首頁的說明文字已經整理好了，連結也檢查過，都可以正常開啟。");
  for (const c of [{ device: "desk", theme: "light", lang: "zh-TW" }, { device: "phone", theme: "dark", lang: "zh-TW" }] as const) {
    const p = await fx.page(c), page = p.page, tag = `${c.device}-${c.theme}-${c.lang}`, phone = c.device === "phone", errors: string[] = [];
    await page.emulateMedia({ reducedMotion: "reduce" });
    page.on("pageerror", (e: Error) => errors.push(e.message));
    const shot = async (name: string) => { await page.waitForTimeout(400); const path = `m3905-${tag}-${name}.png`; await page.screenshot({ path: join(OUT, path) }); receipt.pictures.push({ path, sha256: createHash("sha256").update(readFileSync(join(OUT, path))).digest("hex") }); };
    await page.goto(fx.base + `/ui/fleet/tasks?card=${card.code}`); await page.locator(".tl-comment").first().waitFor({ timeout: 20000 }); await page.waitForTimeout(1500);
    // 1. The stream: every agent's name in a comment's head is whole (not "gene…").
    const names = await page.evaluate(`[...document.querySelectorAll(".tl-comment > .tl-head .tb-who")].map((e) => ({ text: e.textContent, cut: e.scrollWidth > e.clientWidth + 1 }))`) as Array<{ text: string; cut: boolean }>;
    receipt.measured[`${tag}-names`] = names;
    check(`${tag}: every name in a comment's head is whole`, names.length >= 3 && names.every((n) => !n.cut), names);
    // The words wrap without a short tail (text-wrap pretty) and break as the chat's messages do (no keep-all).
    const wrap = await page.evaluate(`[...document.querySelectorAll(".tl-comment .tl-body")].map((e) => { const s = getComputedStyle(e); return s.wordBreak + "/" + (s.textWrapStyle || s.textWrap || ""); })`) as string[];
    check(`${tag}: comment words avoid a short last line (text-wrap pretty)`, wrap.length > 0 && wrap.every((w) => /^normal\/pretty/.test(w)), wrap);
    // Each character's line top: a word kept whole has one top; 「嗎？」 shares its line with the word before it.
    const tops = async (word: string) => await page.evaluate(`(() => { for (const b of document.querySelectorAll(".tl-comment .tl-body")) {
        const w = document.createTreeWalker(b, NodeFilter.SHOW_TEXT); let t; while ((t = w.nextNode())) { const i = t.textContent.indexOf(${JSON.stringify(word)});
          if (i < 0) continue; const r = document.createRange();
          return [...${JSON.stringify(word)}].map((_, k) => { r.setStart(t, i + k); r.setEnd(t, i + k + 1); return Math.round(r.getBoundingClientRect().top); }); } }
      return null; })()`) as number[] | null;
    const oneLine = (x: number[] | null) => !!x && x.every((v) => v === x[0]);
    for (const w of ["可以嗎？", "謝謝"]) { const x = await tops(w); receipt.measured[`${tag}-${w}`] = x; check(`${tag}: 「${w}」 stays on one line`, oneLine(x), x); }
    // The card's history lines fold into "› N activities": open them to read 「建立卡片」.
    if (await page.locator(".tl-list .tl-more").count()) { await page.locator(".tl-list .tl-more").first().click(); await page.waitForTimeout(400); }
    const stream = await page.locator(".tl-list").first().innerText();
    check(`${tag}: the history line says 「建立卡片」`, stream.includes("建立卡片") && !stream.includes("開卡"), stream.slice(0, 400));
    check(`${tag}: 「（已補充）」 keeps full-width parentheses`, stream.includes("（已補充）"), stream.slice(0, 400));
    await page.evaluate(`document.querySelector(".tl-comment").scrollIntoView({ block: "start" })`); await page.waitForTimeout(300);
    await shot("1-stream");
    if (phone) {
      // A narrower phone (360): before M-3905 a name was cut short here ("gene…").
      await page.setViewportSize({ width: 360, height: 800 }); await page.waitForTimeout(300);
      await page.evaluate(`document.querySelector(".tl-comment").scrollIntoView({ block: "start" })`);
      // A head that wrapped keeps its tools at the right edge, under the time.
      const right = await page.evaluate(`[...document.querySelectorAll(".tl-comment > .tl-head")].map((h) => { const t = h.querySelector(".tl-tools"); return t ? Math.round(h.getBoundingClientRect().right - t.getBoundingClientRect().right) : 0; })`) as number[];
      check(`${tag}: at 360 every comment's tools end at the head's right edge`, right.length > 0 && right.every((d) => Math.abs(d) <= 1), right);
      await shot("1b-stream-360");
      await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(300);
      await page.evaluate(`document.querySelector(".tl-comment").scrollIntoView({ block: "start" })`); await page.waitForTimeout(200);
    }
    // 2. A comment's ⋯ menu: 「新增反應」.
    await page.locator(".tl-comment .tl-tools .tl-menu button.icon-btn").first().click(); await page.waitForTimeout(400);
    const menu = await page.locator(".tl-menu .menu-list").first().innerText().catch(() => "");
    check(`${tag}: the comment menu says 「新增反應」`, menu.includes("新增反應") && !menu.includes("加反應"), menu);
    // The open menu is on top: every point of it hits the menu, not a comment drawn over it.
    const covered = await page.evaluate(`(() => { const m = document.querySelector(".tl-menu .menu-list"); if (!m) return ["no menu"]; const b = m.getBoundingClientRect(), out = [];
      for (let y = b.top + 4; y < b.bottom - 2; y += 8) for (let x = b.left + 4; x < b.right - 2; x += 24) { const e = document.elementFromPoint(x, y); if (e && !m.contains(e)) out.push(Math.round(x) + "," + Math.round(y) + " " + (e.className || e.tagName)); }
      return out.slice(0, 6); })()`) as string[];
    check(`${tag}: nothing is drawn over the open menu`, covered.length === 0, covered);
    await shot("2-menu");
    await page.keyboard.press("Escape"); await page.waitForTimeout(300);
    // 3. Who the comment is for: the chip's list has 「不通知 Agent」.
    await page.locator(".tc-composer .tc-to").first().scrollIntoViewIfNeeded(); await page.locator(".tc-composer .tc-to").first().click(); await page.waitForTimeout(400);
    const to = await page.locator(".tc-to-menu").first().innerText().catch(() => "");
    await page.evaluate(`(() => { const l = document.querySelector(".tc-to-menu .menu-list"); if (l) l.scrollIntoView({ block: "end" }); })()`); await page.waitForTimeout(300);
    check(`${tag}: who the comment is for offers 「不通知 Agent」`, to.includes("不通知 Agent") && !to.includes("不通知 agent"), to);
    await shot("3-recipients");
    if (phone) {
      // Phones are 320 to 430 wide: at each width, an agent's name in a comment's head, a history line or the comment box's chip is whole, no comment ends
      // in one or two characters broken off a phrase (「嗎？」 under 「可以」), and 「謝謝」 is never split. A whole word after 「，」 on a line of
      // its own is a phrase break: measured (phraseTails), not failed.
      await page.keyboard.press("Escape"); await page.waitForTimeout(200);
      const sweep: Record<string, number[]> = { cutNames: [], shortTails: [], splitThanks: [] };
      for (let w = 320; w <= 430; w += 2) {
        await page.setViewportSize({ width: w, height: 844 }); await page.waitForTimeout(80);
        const m = await page.evaluate(`(() => {
          const cut = [...document.querySelectorAll(".tl-comment > .tl-head .tb-who, .tl-line .tl-who > b, .tc-composer .tc-to-text")].some((e) => e.textContent && e.scrollWidth > e.clientWidth + 1);
          let short = false, phrase = false, split = false; const r = document.createRange();
          for (const b of document.querySelectorAll(".tl-comment .tl-body")) {
            const chars = []; const tw = document.createTreeWalker(b, NodeFilter.SHOW_TEXT); let t;
            while ((t = tw.nextNode())) for (let k = 0; k < t.textContent.length; k++) { if (!t.textContent[k].trim()) continue; r.setStart(t, k); r.setEnd(t, k + 1); chars.push({ c: t.textContent[k], top: Math.round(r.getBoundingClientRect().top) }); }
            if (!chars.length) continue; const tops = [...new Set(chars.map((x) => x.top))];
            const tail = chars.filter((x) => x.top === tops[tops.length - 1]), before = chars[chars.length - tail.length - 1];
            // Broken off mid-phrase: the character before the tail is a letter, not punctuation (a whole word after 「，」 is a phrase break).
            if (tops.length > 1 && tail.length <= 2) { if (!/[，。、；：！？）」』,.;:!?)]/.test(before.c)) short = tail.map((x) => x.c).join(""); else phrase = tail.map((x) => x.c).join(""); }
            const s = chars.map((x) => x.c).join(""), i = s.indexOf("謝謝"); if (i >= 0 && chars[i].top !== chars[i + 1].top) split = true;
          }
          return { cut, short, phrase, split }; })()`) as { cut: boolean; short: false | string; phrase: false | string; split: boolean };
        if (m.cut) sweep.cutNames.push(w); if (m.short) { sweep.shortTails.push(w); (sweep.tailText ??= [] as any).push(m.short); }
        if (m.phrase) { (sweep.phraseTails ??= []).push(w); (sweep.phraseText ??= [] as any).push(m.phrase); } if (m.split) sweep.splitThanks.push(w);
      }
      receipt.measured[`${tag}-sweep-320-430`] = sweep;
      check(`${tag}: at every phone width (320–430) the names are whole`, sweep.cutNames.length === 0, sweep.cutNames);
      check(`${tag}: at every phone width no comment ends in a character or two broken off a phrase`, sweep.shortTails.length === 0, sweep.shortTails);
      check(`${tag}: at every phone width 「謝謝」 stays whole`, sweep.splitThanks.length === 0, sweep.splitThanks);
      await page.setViewportSize({ width: 390, height: 844 });
    }
    check(`${tag}: no page errors`, errors.length === 0, errors);
    await p.ctx.close();
  }
} finally {
  await fx.close();
  const failed = receipt.checks.filter((x: any) => !x.ok).length; receipt.summary = `${receipt.checks.length - failed}/${receipt.checks.length}`;
  writeFileSync(join(OUT, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n"); console.log(`checks ${receipt.summary}`); process.exitCode = failed ? 1 : 0;
}
