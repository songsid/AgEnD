/**
 * M-3770 S-241 real-app captures (owned web fixture; no Fleet/CLI starts, accounts, npm or external services): Lumen's
 * point 8 — once the admin has answered the update card, a phone shows the banner as one line (short words + Change);
 * Change opens the full line. The desk is unchanged. Driven through the REAL server objects (S-234's UpdateOfferCard and
 * the answer route); nothing installs: every launch path is stubbed before the first press.
 *   1 Update when idle → waiting (phone: closed, then 1b opened) · 2 Tonight → scheduled (phone: closed, then 2b opened).
 * Matrix: desk light en, desk dark zh-TW, phone light en, phone dark zh-TW.
 *   CHROME=<chromium> PW_DIR=<playwright-core> REPO=<checkout> OUT=<dir> npx tsx scripts/manual/update-followups-s241/capture.mts
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, caseName, matrix, mounted } from "../smoke-fixture/index.mts";

const OUT = process.env.OUT!, REPO = process.env.REPO!;
mkdirSync(OUT, { recursive: true });
const git = (...a: string[]) => execFileSync("git", ["-C", REPO, "-c", "gc.auto=0", ...a], { encoding: "utf8" }).trim();
const receipt: any = { sourceHead: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain", "--", "src").split("\n").filter(Boolean), checks: [], pictures: [], heights: {} };
const check = (name: string, ok: unknown, detail?: unknown) => { receipt.checks.push({ name, ok: !!ok, ...(ok ? {} : { detail }) }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail)}`}`); };
const shot = async (page: any, name: string) => {
  await page.waitForTimeout(500);
  const path = `s241-${name}.png`;
  await page.screenshot({ path: join(OUT, path) });
  receipt.pictures.push({ path, sha256: createHash("sha256").update(readFileSync(join(OUT, path))).digest("hex") });
};

const fx = await bootFixture({ port: 0, classic: false, host: true, roster: [
  { name: "general", general: true, backend: "claude-code", displayName: "General", status: "running" },
  { name: "dev", backend: "claude-code", displayName: "Example helper", status: "running" },
  { name: "writer", backend: "codex", displayName: "writer", status: "running" },
] });
const fm = fx.fm;
const launches: string[] = [];
fm.launchInstalledUpdate = async (origin: string) => { launches.push(origin); return null; };
fm.startWebUpdate = async () => { launches.push("web"); return { ok: false, status: 503, error: "capture_no_install" }; };
fm.getInstanceExecutionState = (name: string) => (name === "general" ? "idle" : "working");
const { summarize } = await import(REPO + "/src/update-readiness.ts");
const SELF = summarize([{ id: "P1", ok: true }, { id: "P2", ok: true }, { id: "P3", ok: true }, { id: "P4", ok: true }, { id: "P5", ok: true }, { id: "P8", ok: true }, { id: "P9", ok: true }], Date.now());
fm.updatePreflight = SELF; fm.probeUpdatePreflight = async () => SELF;
const current = fm.runningAgendVersion();
const NEXT = current.replace(/(\d+)$/, (n: string) => String(Number(n) + 1));
fm.recordUpdateCheck(current, { target: NEXT, fromChannel: true });
const card = () => fm.updateOfferView();
const reset = async () => { const c = card(); if (c && (c.state === "waiting-idle" || c.state === "scheduled")) await fm.ensureUpdateCard().answer(`reset-${Date.now()}`, "admin", { action: "cancel" }); };

const W = (zh: boolean, en: string, zhText: string) => (zh ? zhText : en);
const lineText = async (page: any) => page.evaluate(`(document.querySelector(".update-line") || {}).innerText || ""`) as Promise<string>;
/** The banner's height, the title's rendered lines, and which buttons are drawn. */
const geom = async (page: any) => page.evaluate(`(() => {
  const line = document.querySelector(".update-line"), title = line && line.querySelector(".update-title");
  const lh = title ? parseFloat(getComputedStyle(title).lineHeight) : 0;
  return { h: line ? Math.round(line.getBoundingClientRect().height) : 0,
    titleLines: title ? Math.round(title.getBoundingClientRect().height / lh) : 0,
    clipped: title ? title.scrollWidth > title.clientWidth + 1 : null,
    drawn: [...(line ? line.querySelectorAll("button") : [])].filter((b) => b.getBoundingClientRect().width).map((b) => b.innerText.trim()),
    inside: [...(line ? line.querySelectorAll("button") : [])].filter((b) => b.getBoundingClientRect().width).every((b) => { const r = b.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; }),
    taps: [...(line ? line.querySelectorAll("button") : [])].filter((b) => b.getBoundingClientRect().width).map((b) => Math.round(b.getBoundingClientRect().height)),
    sub: [...(line ? line.querySelectorAll(".update-sub") : [])].filter((s) => s.getBoundingClientRect().width).length,
    scroll: document.documentElement.scrollWidth <= innerWidth };
})()`) as Promise<{ h: number; titleLines: number; clipped: boolean | null; drawn: string[]; inside: boolean; taps: number[]; sub: number; scroll: boolean }>;
const click = async (page: any, text: string) => { await page.locator(".update-line button", { hasText: text }).first().click(); await page.waitForTimeout(800); };

async function walk(c: any) {
  const tag = caseName(c), zh = c.lang === "zh-TW", phone = c.device === "phone";
  await reset();
  const { page, ctx } = await fx.page(c, { path: "/ui/needs" });
  const errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message));
  const change = W(zh, "Change", "變更"), close = W(zh, "Hide", "收起");
  try {
    await page.goto(fx.base + "/ui/needs"); check(`${tag}: mounted`, await mounted(page, 30000));
    await page.waitForSelector(".update-line", { timeout: 20000 });
    const offered = await geom(page);
    receipt.heights[`${tag}-offered`] = offered.h;
    check(`${tag} 0: offered is not folded (no Change)`, !offered.drawn.includes(change), offered);
    // 1 Update when idle → waiting
    await click(page, W(zh, "Update when idle", "閒置時更新"));
    check(`${tag} 1: waiting on the server`, card()?.state === "waiting-idle", card());
    let g = await geom(page), t = await lineText(page);
    receipt.heights[`${tag}-waiting`] = g.h;
    if (phone) {
      check(`${tag} 1: one line: the short words and Change only`, t.trim().startsWith(W(zh, "AgEnD updates when idle", "AgEnD 閒置時更新")) && g.titleLines === 1 && !g.clipped
        && JSON.stringify(g.drawn) === JSON.stringify([change]) && g.sub === 0, { t, g });
      check(`${tag} 1: the banner is one 44 px button high plus its padding: at most 66 px (was ${offered.h} px offered)`, g.h <= 66, g);
      check(`${tag} 1: Change is a 44 px button, on the screen`, g.taps.every((x) => x >= 44) && g.inside, g);
      await shot(page, `${tag}-1-waiting`);
      // A phone held sideways (a landscape touch screen) is still the app's phone layout: still one line (#4558 review).
      await page.setViewportSize({ width: 844, height: 390 }); await page.waitForTimeout(400);
      const side = await geom(page);
      check(`${tag} 1: sideways (844×390, touch): still one line with Change`, JSON.stringify(side.drawn) === JSON.stringify([change]) && side.sub === 0 && side.h <= 66, side);
      await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(400);
      await click(page, change);
      g = await geom(page); t = await lineText(page);
      check(`${tag} 1b: Change opens the full line: the words, who it waits for, Update now / Pick a time / Cancel / Close`,
        t.includes(W(zh, `Updating to ${NEXT} as soon as your agents are idle.`, `Agent 一閒置就更新到 ${NEXT}。`)) && g.sub === 1
        && [W(zh, "Update now", "立即更新"), W(zh, "Pick a time", "選個時間"), W(zh, "Cancel", "取消"), close].every((x) => g.drawn.includes(x)), { t, g });
      check(`${tag} 1b: 44 px buttons, every one wholly on the screen, no sideways scroll`, g.taps.every((x) => x >= 44) && g.inside && g.scroll, g);
      receipt.heights[`${tag}-waiting-open`] = g.h;
      await shot(page, `${tag}-1b-waiting-open`);
    } else {
      check(`${tag} 1: the desk is unchanged: the full words, who it waits for, the buttons; no short words, no Change`,
        t.includes(W(zh, `Updating to ${NEXT} as soon as your agents are idle.`, `Agent 一閒置就更新到 ${NEXT}。`)) && g.sub === 1 && !g.drawn.includes(change)
        && !t.includes(W(zh, "AgEnD updates when idle", "AgEnD 閒置時更新")) && [W(zh, "Update now", "立即更新"), W(zh, "Cancel", "取消")].every((x) => g.drawn.includes(x)), { t, g });
      await shot(page, `${tag}-1-waiting`);
      // 701–899 px is the app's phone layout too (the shell's narrow condition): one line there, the full line from 900 (#4558 review).
      for (const w of [701, 800, 899]) {
        await page.setViewportSize({ width: w, height: 900 }); await page.waitForTimeout(400);
        const n = await geom(page);
        check(`${tag} 1: ${w} px wide (the app's phone layout): one line with Change`, JSON.stringify(n.drawn) === JSON.stringify([change]) && n.sub === 0 && n.h <= 66, n);
      }
      await page.setViewportSize({ width: 900, height: 900 }); await page.waitForTimeout(400);
      const wide = await geom(page);
      check(`${tag} 1: 900 px wide (the desk layout): the full line, no Change`, !wide.drawn.includes(change) && wide.sub === 1, wide);
      await page.setViewportSize({ width: 1366, height: 900 }); await page.waitForTimeout(400);
    }
    check(`${tag} 1: opening it decided nothing`, card()?.state === "waiting-idle", card());
    // 2 Cancel → offered; Pick a time → Tonight → scheduled
    await click(page, W(zh, "Cancel", "取消"));
    check(`${tag} 2: Cancel from the opened line → offered`, card()?.state === "offered", card());
    await click(page, W(zh, "Pick a time", "選個時間"));
    await page.waitForSelector("dialog.dlg[open]", { timeout: 10000 });
    await page.locator("dialog.dlg[open] input[type=radio]").nth(0).check(); await page.waitForTimeout(200);
    await page.locator("dialog.dlg[open] .btn-primary").click(); await page.waitForTimeout(900);
    check(`${tag} 2: scheduled on the server`, card()?.state === "scheduled", card());
    g = await geom(page); t = await lineText(page);
    receipt.heights[`${tag}-scheduled`] = g.h;
    if (phone) {
      check(`${tag} 2: one line again (a new state starts closed): the weekday and the 24-hour time, and Change`,
        /^AgEnD (\S+ \d\d:\d\d 更新|updates \S+ \d\d:\d\d)$/.test(t.split("\n")[0]!.trim()) && g.titleLines === 1 && !g.clipped && JSON.stringify(g.drawn) === JSON.stringify([change]), { t, g });
      check(`${tag} 2: no AM/PM`, !/AM|PM|上午|下午/.test(t), t);
      check(`${tag} 2: the banner is at most 66 px`, g.h <= 66, g);
      await shot(page, `${tag}-2-scheduled`);
      await click(page, change);
      g = await geom(page); t = await lineText(page);
      check(`${tag} 2b: opened: the full time, Update now / Cancel / Close`, t.includes(W(zh, "when your agents are idle", "等 Agent 閒置後更新到"))
        && [W(zh, "Update now", "立即更新"), W(zh, "Cancel", "取消"), close].every((x) => g.drawn.includes(x)), { t, g });
      check(`${tag} 2b: every button wholly on the screen`, g.inside, g);
      receipt.heights[`${tag}-scheduled-open`] = g.h;
      await shot(page, `${tag}-2b-scheduled-open`);
    } else {
      check(`${tag} 2: the desk is unchanged: the full time and the buttons, no Change`, t.includes(W(zh, "when your agents are idle", "等 Agent 閒置後更新到")) && !g.drawn.includes(change)
        && [W(zh, "Update now", "立即更新"), W(zh, "Cancel", "取消")].every((x) => g.drawn.includes(x)), { t, g });
      await shot(page, `${tag}-2-scheduled`);
    }
    await click(page, W(zh, "Cancel", "取消"));
    check(`${tag}: no page errors`, errors.length === 0, errors);
  } finally { await ctx.close(); }
}

try {
  for (const c of matrix("desk-light-en,desk-dark-zh-TW,phone-light-en,phone-dark-zh-TW")) await walk(c);
  check("nothing was installed: no launch reached", launches.length === 0, launches);
} finally {
  await fx.close();
  const failed = receipt.checks.filter((x: any) => !x.ok).length;
  receipt.summary = `${receipt.checks.length - failed}/${receipt.checks.length}`;
  writeFileSync(join(OUT, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(`checks ${receipt.summary}`);
  process.exitCode = failed ? 1 : 0;
}
