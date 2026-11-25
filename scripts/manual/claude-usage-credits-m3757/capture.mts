// M-3757 real-app captures: the Needs-you card for Claude Code 2.1.332's usage-credits prompt, and the confirm step a
// credits choice asks for. Real web HTTP, sessions and DOM (scripts/manual/smoke-fixture), inert agents; the card is the
// one AgEnD reads from the live 2.1.332 capture (tests/fixtures/claude-2.1.332-usage-credits-consent-dialog.pane.txt),
// posted through FleetManager.postRemoteCard as the daemon's remote_card would. No CLI, account or Fleet start.
//   REPO=<checkout> PW_DIR=<dir with playwright-core> OUT=<dir> npx tsx scripts/manual/claude-usage-credits-m3757/capture.mts
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, shotPath } from "../smoke-fixture/index.mts";

const smoke = "claude-usage-credits-m3757", OUT = process.env.OUT!, REPO = process.env.REPO!;
const git = (...a: string[]) => execFileSync("git", ["-C", REPO, "-c", "gc.auto=0", ...a], { encoding: "utf8" }).trim();
const receipt: any = { sourceHead: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain", "--", "src").split("\n").filter(Boolean), checks: [], pictures: [] };
const check = (name: string, ok: unknown, detail?: unknown) => { receipt.checks.push({ name, ok: !!ok, ...(ok ? {} : { detail }) }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail)}`}`); };
// A control's box: shown, and (phone) at least the 44 px tap target; controls in order never overlap.
const boxOf = (els: Element[]) => els.map(e => { const r = e.getBoundingClientRect(); return { w: Math.round(r.width), x: Math.round(r.left), y: Math.round(r.top), h: Math.round(r.height), b: Math.round(r.bottom) }; });
const tapOk = (bs: Array<{ w: number; h: number; y: number; b: number }>, min: number) => bs.length > 0 && bs.every(b => b.w > 0 && b.h >= min) && bs.every((b, i) => i === 0 || b.y >= bs[i - 1]!.b);
const { claudeUsageCreditsPrompt } = await import(REPO + "/src/backend/claude-usage-credits.ts");
const { setLocale, t } = await import(REPO + "/src/locale.ts");
const LIVE = readFileSync(join(REPO, "tests/fixtures/claude-2.1.332-usage-credits-consent-dialog.pane.txt"), "utf8");

const fx = await bootFixture({ port: 0, classic: false, host: true, roster: [
  { name: "lumen", displayName: "Lumen", backend: "claude-code" }, { name: "atlas", displayName: "Atlas", backend: "codex" },
] });
// The daemon's side, as smoke-codex-stopped-m3519 does: the instance waits at a dialog, and an answer would go to its daemon
// (counted: the confirmation must come before any key).
const fm = fx.fm;
let answers = 0;
const presentation = { state: "awaiting_input", execution_state: "working", interaction_summary: "Waiting at a dialog",
  interaction: { phase: "waiting", kind: "dialog", episode: 1, owner: { bootId: "demo", spawnGeneration: 1, launchAttempt: 1, launchFenceEpoch: 0 }, since: Date.now(), observedAt: Date.now(), confirmedAt: Date.now(), stale: false, suspected: false } };
// Only Lumen waits; the other agent keeps the fleet's own presentation.
const ownPresentation = fm.instancePresentation.bind(fm), ownInteraction = fm.getInstanceInteraction.bind(fm);
fm.instancePresentation = (name: string, ...rest: unknown[]) => (name === "lumen" ? presentation : ownPresentation(name, ...rest));
fm.getInstanceInteraction = (name: string, ...rest: unknown[]) => (name === "lumen" ? presentation.interaction : ownInteraction(name, ...rest));
fm.daemons.set("lumen", { answerRemoteCard: async () => { answers++; return { outcome: "answered" }; } });
fm.startNeedsYou();
try {
  for (const [device, lang, theme] of [["desk", "en", "light"], ["desk", "zh-TW", "dark"], ["desk", "zh-TW", "light"], ["phone", "en", "light"], ["phone", "zh-TW", "dark"], ["phone", "zh-TW", "light"]] as const) {
    const c = { device, lang, theme } as const, tag = `${device}-${lang}-${theme}`;
    setLocale(lang === "zh-TW" ? "zh-TW" : "en");                   // the card's subtitles and confirmation are the fleet's language
    presentation.interaction_summary = t("interactive.kind.dialog");
    const card = claudeUsageCreditsPrompt(LIVE)!.card;
    await fm.postRemoteCard("lumen", card); fm.needsYou.recompute();
    const { ctx, page } = await fx.page(c, { path: "/ui/needs", host: true });
    const errors: string[] = [];
    page.on("pageerror", (e: any) => errors.push(String(e)));
    try {
      const zh = lang === "zh-TW";
      const W = zh
        ? { title: "Fable 5.2 要另外收費，要換模型嗎？", sw: "換成 Opus 5.5（用方案額度）", cr: "繼續用 Fable 5.2（另外扣點數）", raw: "看 Claude 原文", open: "開啟聊天" }
        : { title: "Fable 5.2 costs extra. Switch model?", sw: "Switch to Opus 5.5 (uses your plan)", cr: "Keep Fable 5.2 (billed to credits)", raw: "Show Claude's text", open: "Open chat" };
      const card = page.locator("article.n-compact").first();
      await card.waitFor({ state: "visible", timeout: 20_000 });
      const titleEl = card.locator(".n-title strong");
      check(`${tag}: the title is in the UI language, without the agent name the group header already shows`, (await titleEl.innerText()).trim() === W.title, await titleEl.innerText());
      const lines = await titleEl.evaluate((e: Element) => { const r = document.createRange(); r.selectNodeContents(e); return new Set([...r.getClientRects()].map(x => Math.round(x.top))).size; });
      check(`${tag}: the title fits on one line`, lines === 1, lines);
      const buttons = card.locator(".n-stack > .btn");
      const labels = (await buttons.allInnerTexts()).map(x => x.trim());
      check(`${tag}: two stacked buttons, named by what they do`, JSON.stringify(labels) === JSON.stringify([W.sw, W.cr]), labels);
      const boxes = await buttons.evaluateAll(boxOf);
      const minTap = device === "phone" ? 44 : 24;
      check(`${tag}: the buttons are one width, stacked, one line each`, boxes.length === 2 && boxes[0].w === boxes[1].w && boxes[0].x === boxes[1].x && boxes.every(b => b.h >= minTap && b.h < 64), boxes);
      const controls = await card.locator(".n-stack > .btn, details.n-raw > summary, a.n-link").evaluateAll(boxOf);
      check(`${tag}: every control is shown${device === "phone" ? ", a 44 px tap target," : ""} and none overlaps the next`, controls.length === 4 && tapOk(controls, device === "phone" ? 44 : 12), controls);
      check(`${tag}: the switch is the primary button`, await buttons.first().evaluate((e: Element) => e.classList.contains("btn-primary")), null);
      const raw = card.locator("details.n-raw");
      check(`${tag}: Claude's own words are folded by default`, !(await raw.evaluate((e: any) => e.open)) && !(await card.locator(".n-raw-text").isVisible()), null);
      const cardText = await card.innerText();
      check(`${tag}: no emoji, no Claude body or labels on the card`, !/❓|now uses usage credits|Continue with Fable/.test(cardText) && cardText.includes(W.raw), cardText);
      check(`${tag}: "open chat" is a small link, not a button`, (await card.locator("a.n-link").innerText()).trim() === W.open && (await card.locator("a.btn").count()) === 0, null);
      check(`${tag}: no Esc / Skip choice is offered`, !/\bSkip\b|略過/.test(cardText), cardText);
      let path = shotPath(smoke, tag, "1-needs-card"); await page.screenshot({ path }); receipt.pictures.push(path);
      await raw.locator("summary").click();
      check(`${tag}: the toggle shows Claude's own words`, (await card.locator(".n-raw-text").innerText()).includes("Fable 5.2 now uses usage credits"), null);
      let pathRaw = shotPath(smoke, tag, "3-claude-text"); await page.screenshot({ path: pathRaw }); receipt.pictures.push(pathRaw);
      await raw.locator("summary").click();
      await card.getByRole("button", { name: W.cr, exact: true }).click();
      const dialog = page.getByRole("dialog");
      await dialog.waitFor({ state: "visible", timeout: 10_000 });
      const words = await dialog.innerText();
      const want = lang === "en"
        ? ["Keep Lumen on Fable 5.2?", "Lumen's replies may be billed to usage credits, separate from your plan.", "Continue on credits", "Cancel"]
        : ["讓 Lumen 繼續用 Fable 5.2？", "Lumen 之後的回覆可能會另外從用量點數扣款（不在方案內）。", "繼續（用點數）", "取消"];
      check(`${tag}: the credits choice asks to be confirmed first, naming the agent in plain words`, want.every(w => words.includes(w)) && !/回合|answers/.test(words), words);
      check(`${tag}: no key went to the pane before the confirmation`, answers === 0, answers);
      // No widow: the body's last line is not a stub of the line above it (e.g. 「案內）。」 alone), in every language and size.
      const lineWidths = await dialog.locator(".confirm-text").first().evaluate((e: Element) => {
        const r = document.createRange(); r.selectNodeContents(e); const rows = new Map<number, number>();
        for (const x of r.getClientRects()) { const k = Math.round(x.top); rows.set(k, (rows.get(k) ?? 0) + x.width); }
        return [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, w]) => Math.round(w));
      });
      check(`${tag}: the confirmation's text leaves no lone last word`, lineWidths.length === 1 || lineWidths[lineWidths.length - 1]! >= 0.4 * lineWidths[lineWidths.length - 2]!, lineWidths);
      const cw = await dialog.locator(".dlg-actions .btn").evaluateAll((els: Element[]) => els.map(e => Math.round(e.getBoundingClientRect().width)));
      check(`${tag}: the confirmation's two buttons are one width`, cw.length === 2 && Math.abs(cw[0] - cw[1]) <= 1, cw);
      path = shotPath(smoke, tag, "2-confirm-credits"); await page.screenshot({ path }); receipt.pictures.push(path);
      await dialog.getByRole("button", { name: lang === "en" ? "Cancel" : "取消", exact: true }).click();
      await page.waitForTimeout(300);
      check(`${tag}: cancelled, still no answer sent`, answers === 0, answers);
      // The dialog's ✕ is the same as Cancel: no answer, the card stays.
      await card.getByRole("button", { name: W.cr, exact: true }).click();
      await dialog.waitFor({ state: "visible", timeout: 10_000 });
      await dialog.locator(".dlg-x").click();
      await dialog.waitFor({ state: "hidden", timeout: 5_000 });
      check(`${tag}: the ✕ closes the confirmation like Cancel — no answer sent, the card stays`, answers === 0 && (await card.isVisible()), answers);
      // The chat's compact prompt: the same choices, the same tap targets.
      await page.goto(page.url().replace(/\/ui\/needs.*$/, "/ui/chat/lumen"));
      const chat = page.locator(".prompt-compact").first();
      await chat.waitFor({ state: "visible", timeout: 20_000 });
      check(`${tag}: the chat names the agent in its title`, (await chat.locator(".txt strong").innerText()).trim() === (zh ? "Lumen：Fable 5.2 要另外收費，要換模型嗎？" : "Lumen: Fable 5.2 now costs extra. Switch model?"), await chat.locator(".txt strong").innerText());
      const chatControls = await chat.locator(".acts-stack > .btn, details.n-raw > summary").evaluateAll(boxOf);
      check(`${tag}: chat — every control is shown${device === "phone" ? ", a 44 px tap target," : ""} and none overlaps the next`, chatControls.length === 3 && tapOk(chatControls, device === "phone" ? 44 : 12), chatControls);
      const pathChat = shotPath(smoke, tag, "4-chat"); await page.screenshot({ path: pathChat }); receipt.pictures.push(pathChat);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      check(`${tag}: no horizontal overflow`, !overflow, overflow);
      check(`${tag}: cancelling the confirmation leaves the prompt (nothing answered)`, answers === 0 && await chat.isVisible(), answers);
      check(`${tag}: no page errors`, errors.length === 0, errors);
    } finally { await ctx.close(); }
  }
} finally {
  await fm.needsYou?.stop?.(); fm.daemons.clear();
  receipt.pictures = receipt.pictures.map((p: string) => ({ path: p.split("/").slice(-2).join("/"), sha256: createHash("sha256").update(readFileSync(p)).digest("hex") }));
  writeFileSync(join(OUT, smoke, "receipt.json"), JSON.stringify(receipt, null, 2));
  await fx.close();
}
const failed = receipt.checks.filter((x: any) => !x.ok);
console.log(failed.length ? `FAIL ${failed.length}` : `PASS ${receipt.checks.length}`);
process.exit(failed.length ? 1 : 0);
