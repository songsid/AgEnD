/**
 * M-3770 slice 1.4 real-app captures (owned web fixture; no Fleet/CLI starts, accounts, npm or external services): the
 * update card on the web, driven through the REAL server objects (S-234's UpdateOfferCard, S-235's pre-flight result,
 * the answer route) — nothing installs: every launch path is stubbed before the first press.
 *   1 offered on a service install (two sentences; Update when idle / Pick a time / Not now) · 2 Pick a time · 3 scheduled ·
 *   4 waiting for idle (who is busy; Update now / Pick a time / Cancel) · 5 a press-only machine (no-write: no button, the
 *   words) · 6 Settings → Version and update (state, "Updates on this machine", Don't update during, Advanced) ·
 *   7 Needs you when AgEnD can't update here.
 * Desk light en and phone dark zh-TW for all; desk dark zh-TW and phone light en for frame 1.
 *   CHROME=<chromium> PW_DIR=<playwright-core> REPO=<checkout> OUT=<dir> npx tsx scripts/manual/update-card-web-s237/capture.mts
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, caseName, matrix, mounted } from "../smoke-fixture/index.mts";

const OUT = process.env.OUT!, REPO = process.env.REPO!;
mkdirSync(OUT, { recursive: true });
const git = (...a: string[]) => execFileSync("git", ["-C", REPO, "-c", "gc.auto=0", ...a], { encoding: "utf8" }).trim();
const receipt: any = { sourceHead: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain", "--", "src").split("\n").filter(Boolean), checks: [], pictures: [], seen: {} };
const check = (name: string, ok: unknown, detail?: unknown) => { receipt.checks.push({ name, ok: !!ok, ...(ok ? {} : { detail }) }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail)}`}`); };
const shot = async (page: any, name: string) => {
  await page.waitForTimeout(500);
  const path = `s237-${name}.png`;
  await page.screenshot({ path: join(OUT, path) });
  receipt.pictures.push({ path, sha256: createHash("sha256").update(readFileSync(join(OUT, path))).digest("hex") });
};

const fx = await bootFixture({ port: 0, classic: false, host: true, roster: [
  { name: "general", general: true, backend: "claude-code", displayName: "General", status: "running" },
  { name: "dev", backend: "claude-code", displayName: "Example helper", status: "running" },
  { name: "writer", backend: "codex", displayName: "writer", status: "running" },
  { name: "tester", backend: "codex", displayName: "tester", status: "running" },
  { name: "planner", backend: "claude-code", displayName: "planner", status: "running" },
  { name: "reviewer", backend: "claude-code", displayName: "reviewer", status: "running" },
] });
const fm = fx.fm;
// Nothing installs, ever: every launch path is stubbed before the first press.
const launches: string[] = [];
fm.launchInstalledUpdate = async (origin: string) => { launches.push(origin); return null; };
fm.startWebUpdate = async () => { launches.push("web"); return { ok: false, status: 503, error: "capture_no_install" }; };
// Two agents at work: Update when idle waits (and names them).
fm.getInstanceExecutionState = (name: string) => (name === "general" ? "idle" : "working");   // five at work: the names are capped
const { summarize } = await import(REPO + "/src/update-readiness.ts");
const pre = (checks: any[]) => summarize(checks, Date.now());
const SELF = pre([{ id: "P1", ok: true }, { id: "P3", ok: true }, { id: "P4", ok: true }, { id: "P5", ok: true }, { id: "P9", ok: true }]);
const setPreflight = (p: any) => { fm.updatePreflight = p; fm.probeUpdatePreflight = async () => p; };
setPreflight(SELF);
const current = fm.runningAgendVersion();
const NEXT = current.replace(/(\d+)$/, (n: string) => String(Number(n) + 1));
fm.recordUpdateCheck(current, { target: NEXT, fromChannel: true });
fm.fleetConfig.updates = { pause: [{ days: [1, 2, 3, 4, 5], from: "09:00", to: "18:00" }], maxIdleWait: 24 };
const card = () => fm.updateOfferView();
const reset = async () => { const c = card(); if (c && (c.state === "waiting-idle" || c.state === "scheduled")) await fm.ensureUpdateCard().answer(`reset-${Date.now()}`, "admin", { action: "cancel" }); };

const lineText = async (page: any) => page.evaluate(`(document.querySelector(".update-line") || {}).innerText || ""`);
const buttons = async (page: any) => page.evaluate(`[...document.querySelectorAll(".update-line button")].map((b) => b.innerText.trim())`);
const taps = async (page: any) => page.evaluate(`[...document.querySelectorAll(".update-line button, .uc-settings .btn, .uc-settings .input, .uc-day")].filter((e) => e.getBoundingClientRect().width).map((e) => Math.round(e.getBoundingClientRect().height))`);
const scroll = async (page: any) => page.evaluate(`({ w: innerWidth, s: document.documentElement.scrollWidth })`);
const W = (zh: boolean, en: string, zhText: string) => (zh ? zhText : en);

async function walk(c: any, full: boolean) {
  const tag = caseName(c), zh = c.lang === "zh-TW", phone = c.device === "phone";
  await reset(); setPreflight(SELF);
  const { page, ctx } = await fx.page(c, { path: "/ui/needs" });
  const errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message));
  try {
    await page.goto(fx.base + "/ui/needs"); check(`${tag}: mounted`, await mounted(page, 30000));
    await page.waitForSelector(".update-line", { timeout: 20000 });
    let t = await lineText(page), b = await buttons(page);
    check(`${tag} 1: offered: the title and one line`, t.includes(NEXT) && t.includes(W(zh, `Your work continues; if it won't start, AgEnD tries to roll back to ${current}.`, `工作不會中斷；新版起不來時，AgEnD 會嘗試退回 ${current}。`)), t);
    check(`${tag} 1: Update when idle / Pick a time / Not now`, [W(zh, "Update when idle", "閒置時更新"), W(zh, "Pick a time", "選個時間"), W(zh, "Not now", "先不要")].every((x) => b.includes(x)), b);
    if (phone) check(`${tag} 1: 44 px buttons`, (await taps(page)).every((h: number) => h >= 44), await taps(page));
    const sc = await scroll(page); check(`${tag} 1: no sideways scroll`, sc.s <= sc.w, sc);
    await shot(page, `${tag}-1-offered`);
    if (!full) { check(`${tag}: no page errors`, errors.length === 0, errors); return; }
    // 2–3 Pick a time → scheduled
    await page.locator(".update-line button", { hasText: W(zh, "Pick a time", "選個時間") }).click();
    await page.waitForSelector("dialog.dlg[open]", { timeout: 10000 });
    await shot(page, `${tag}-2-pick`);
    await page.locator("dialog.dlg[open] input[type=radio]").nth(2).check(); await page.waitForTimeout(300);
    check(`${tag} 2b: Another time in its frame: a day and a 24-hour time (no native time input)`, (await page.locator("dialog.dlg[open] .uc-pick-frame select.uc-pick-time").count()) === 1
      && (await page.locator("dialog.dlg[open] input[type=time], dialog.dlg[open] input[type=datetime-local]").count()) === 0, null);
    await shot(page, `${tag}-2b-pick-other`);
    await page.locator("dialog.dlg[open] input[type=radio]").nth(0).check(); await page.waitForTimeout(200);
    await page.locator("dialog.dlg[open] .btn-primary").click();
    await page.waitForTimeout(800);
    check(`${tag} 3: scheduled on the server`, card()?.state === "scheduled", card());
    t = await lineText(page);
    check(`${tag} 3: the line says when`, t.includes(W(zh, "when your agents are idle", "等 Agent 閒置時")), t);
    await shot(page, `${tag}-3-scheduled`);
    await page.locator(".update-line button", { hasText: W(zh, "Cancel", "取消") }).click(); await page.waitForTimeout(800);
    check(`${tag} 3: Cancel → offered again`, card()?.state === "offered", card());
    // 4 Update when idle → waiting (names the busy agents)
    await page.locator(".update-line button", { hasText: W(zh, "Update when idle", "閒置時更新") }).click(); await page.waitForTimeout(800);
    check(`${tag} 4: waiting on the server, naming who works`, card()?.state === "waiting-idle" && (card()?.waitingFor || []).length === 5, card());
    t = await lineText(page); b = await buttons(page);
    check(`${tag} 4: the line names two, then +3; Update now / Pick a time / Cancel`, /\+3/.test(t) && !t.includes("reviewer, tester") && [W(zh, "Update now", "立即更新"), W(zh, "Cancel", "取消")].every((x) => b.includes(x)), { t, b });
    await shot(page, `${tag}-4-waiting`);
    await page.locator(".update-line button", { hasText: W(zh, "Cancel", "取消") }).click(); await page.waitForTimeout(800);
    // 5 a press-only machine: no-write → no update button, the words
    setPreflight(pre([{ id: "P1", ok: true }, { id: "P3", ok: true }, { id: "P4", ok: false, code: "no-write", detail: { path: "/usr/local/lib/node_modules" } }]));
    await page.reload(); await page.waitForSelector(".update-line", { timeout: 20000 }); await page.waitForTimeout(600);
    t = await lineText(page); b = await buttons(page);
    check(`${tag} 5: no Update when idle / Pick a time; one plain line; Not now stays`, !b.includes(W(zh, "Update when idle", "閒置時更新")) && t.includes(W(zh, "update it by hand", "請手動更新")) && b.includes(W(zh, "Not now", "先不要")), { t, b });
    check(`${tag} 5: How to update is folded`, !(await page.locator(".update-line details.uc-how").getAttribute("open") !== null), null);
    await shot(page, `${tag}-5-press-only`);
    await page.locator(".update-line details.uc-how summary").click(); await page.waitForTimeout(300);
    check(`${tag} 5: How to update holds the command`, (await lineText(page)).includes("sudo agend update"), await lineText(page));
    await shot(page, `${tag}-5b-how-to`);
    // 6 Settings → Version and update (◐: lingering off)
    setPreflight(pre([{ id: "P1", ok: true }, { id: "P3", ok: false, code: "linger-off", detail: { user: "example" } }, { id: "P4", ok: true }]));
    await page.goto(fx.base + "/settings/advanced"); await mounted(page, 30000);
    await page.waitForSelector("#settings-update .uc-settings", { timeout: 20000 }); await page.waitForTimeout(600);
    await page.evaluate(`document.querySelector("#settings-update")?.scrollIntoView({ block: "start" })`);
    const s = await page.evaluate(`document.querySelector("#settings-update").innerText`) as string;
    check(`${tag} 6: Updates on this machine ◐ with the reason; Don't update during with the saved window`,
      s.includes("◐") && s.includes("example") && s.includes(W(zh, "Don't update during", "這些時段不更新")) && (await page.locator(".uc-pause-row").count()) === 1, s.slice(0, 600));
    if (phone) check(`${tag} 6: 44 px controls`, (await taps(page)).every((h: number) => h >= 44), await taps(page));
    check(`${tag} 6: no top line while Settings is open`, (await page.locator(".update-line").count()) === 0, await lineText(page));
    check(`${tag} 6: no AM/PM time inputs`, (await page.locator("#settings-update input[type=time]").count()) === 0, null);
    check(`${tag} 6: the linger line without jargon`, s.includes("example") && !s.includes("lingering"), s.slice(0, 300));
    await shot(page, `${tag}-6-settings`);
    await page.locator(".uc-advanced summary").click(); await page.waitForTimeout(300);
    await page.evaluate(`document.querySelector(".uc-advanced")?.scrollIntoView({ block: "center" })`);
    await shot(page, `${tag}-6b-advanced`);
    // 7 Needs you: AgEnD can't update here
    setPreflight(pre([{ id: "P9", ok: false, code: "container" }]));
    await page.goto(fx.base + "/ui/needs"); await mounted(page, 30000); await page.waitForTimeout(1200);
    const n = await page.evaluate(`(document.querySelector(".uc-needs") || {}).innerText || ""`) as string;
    check(`${tag} 7: Needs you: the one line`, n.includes(W(zh, "AgEnD runs in a container; update the image.", "AgEnD 在容器裡執行，請更新映像檔。")) && !n.includes(W(zh, "can't update itself", "無法在這台機器上自行更新")), n);
    check(`${tag} 7: and not on the banner too`, (await page.locator(".update-line").count()) === 0, await lineText(page));
    await shot(page, `${tag}-7-needs`);
    check(`${tag}: no page errors`, errors.length === 0, errors);
  } finally { await ctx.close(); }
}

try {
  for (const c of matrix("desk-light-en,phone-dark-zh-TW")) await walk(c, true);
  for (const c of matrix("desk-dark-zh-TW,phone-light-en")) await walk(c, false);
  check("nothing was installed: no launch reached", launches.length === 0, launches);
} finally {
  await fx.close();
  const failed = receipt.checks.filter((x: any) => !x.ok).length;
  receipt.summary = `${receipt.checks.length - failed}/${receipt.checks.length}`;
  writeFileSync(join(OUT, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(`checks ${receipt.summary}`);
  process.exitCode = failed ? 1 : 0;
}
