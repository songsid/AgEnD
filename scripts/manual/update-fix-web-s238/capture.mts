/**
 * M-3770 slice 1.6 real-app captures (owned web fixture; no Fleet/CLI starts, accounts, npm or external services): the
 * pre-flight's fix buttons in Settings → Version and update → "Updates on this machine", through the REAL route
 * (POST /ui/update/fixes) and the real FleetManager method behind it. Nothing changes on this host: the fix itself
 * (`runUpdateFix`, which would run `loginctl enable-linger`) is stubbed before the first press, and every update launch too.
 *   1 lingering off: the line, its command, and Fix it for me · 2 after the press: the fresh pre-flight (✓) and its toast ·
 *   3 a fix that doesn't take: says so, the line and its command stay · 4 not a service: How to fix folds out
 *   `agend install` as code, with no button.
 * Desk light en and phone dark zh-TW.
 *   CHROME=<chromium> PW_DIR=<playwright-core> REPO=<checkout> OUT=<dir> npx tsx scripts/manual/update-fix-web-s238/capture.mts
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, caseName, matrix, mounted } from "../smoke-fixture/index.mts";

const OUT = process.env.OUT!, REPO = process.env.REPO!;
mkdirSync(OUT, { recursive: true });
const git = (...a: string[]) => execFileSync("git", ["-C", REPO, "-c", "gc.auto=0", ...a], { encoding: "utf8" }).trim();
const receipt: any = { sourceHead: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain", "--", "src").split("\n").filter(Boolean), checks: [], pictures: [] };
const check = (name: string, ok: unknown, detail?: unknown) => { receipt.checks.push({ name, ok: !!ok, ...(ok ? {} : { detail }) }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail)}`}`); };
const shot = async (page: any, name: string) => {
  await page.waitForTimeout(400);
  const path = `s238-${name}.png`;
  await page.screenshot({ path: join(OUT, path) });
  receipt.pictures.push({ path, sha256: createHash("sha256").update(readFileSync(join(OUT, path))).digest("hex") });
};

const fx = await bootFixture({ port: 0, classic: false, host: true, roster: [
  { name: "general", general: true, backend: "claude-code", displayName: "General", status: "running" },
  { name: "dev", backend: "claude-code", displayName: "Example helper", status: "running" },
] });
const fm = fx.fm;
// Nothing installs and nothing on this host changes: every launch path and the fix itself are stubbed before the first press.
const launches: string[] = [], fixes: string[] = [];
fm.launchInstalledUpdate = async (origin: string) => { launches.push(origin); return null; };
fm.startWebUpdate = async () => { launches.push("web"); return { ok: false, status: 503, error: "capture_no_install" }; };
const { summarize } = await import(REPO + "/src/update-readiness.ts");
const pre = (checks: any[]) => summarize(checks, Date.now());
const SELF = pre([{ id: "P1", ok: true }, { id: "P3", ok: true }, { id: "P4", ok: true }, { id: "P5", ok: true }, { id: "P9", ok: true }]);
const LINGER_OFF = pre([{ id: "P1", ok: true }, { id: "P3", ok: false, code: "linger-off", detail: { user: "example" } }, { id: "P4", ok: true }, { id: "P9", ok: true }]);
const NOT_SERVICE = pre([{ id: "P1", ok: true }, { id: "P3", ok: false, code: "not-service" }, { id: "P4", ok: true }, { id: "P9", ok: true }]);
const setPreflight = (p: any) => { fm.updatePreflight = p; fm.probeUpdatePreflight = async () => p; };
let fixTakes = true;
fm.runUpdateFix = async (fix: string) => { fixes.push(fix); if (!fixTakes) return { ok: false }; setPreflight(SELF); return { ok: true }; };
const current = fm.runningAgendVersion();
fm.recordUpdateCheck(current, { target: current.replace(/(\d+)$/, (n: string) => String(Number(n) + 1)), fromChannel: true });

const W = (zh: boolean, en: string, zhText: string) => (zh ? zhText : en);
const machine = async (page: any) => page.evaluate(`(document.querySelector("#settings-update .uc-machine") || {}).innerText || ""`) as Promise<string>;
const toasts = async (page: any) => page.evaluate(`[...document.querySelectorAll(".toasts .toast")].map((e) => e.innerText.trim())`) as Promise<string[]>;
// A toast shown in full: one with the whole text and no ellipsis (its box as wide as its text needs).
const toastWhole = async (page: any, text: string) => page.evaluate(`[...document.querySelectorAll(".toasts .toast")].some((e) => e.innerText.trim() === ${JSON.stringify(text)} && e.scrollWidth <= e.clientWidth + 1 && getComputedStyle(e).textOverflow !== "ellipsis")`) as Promise<boolean>;
// A word kept on one line in the checks: its text range's boxes share one top.
const unsplit = async (page: any, word: string, root = "#settings-update .uc-checks") => page.evaluate(`(() => { const w = ${JSON.stringify(word)};
  const walk = document.createTreeWalker(document.querySelector(${JSON.stringify(root)}), NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) { const i = n.data.indexOf(w); if (i < 0) continue;
    const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + w.length);
    return new Set([...r.getClientRects()].filter((b) => b.width).map((b) => Math.round(b.top))).size === 1; }
  return null; })()`);
const cmds = async (page: any) => page.locator("#settings-update .uc-machine .uc-cmd").allInnerTexts() as Promise<string[]>;
const oneLine = async (page: any) => page.evaluate(`[...document.querySelectorAll("#settings-update .uc-machine .uc-cmd")].filter((e) => e.getBoundingClientRect().width).map((e) => e.getClientRects().length)`) as Promise<number[]>;
const fixButtons = async (page: any) => page.evaluate(`[...document.querySelectorAll("#settings-update .uc-machine button")].map((b) => ({ t: b.innerText.trim(), h: Math.round(b.getBoundingClientRect().height) }))`) as Promise<Array<{ t: string; h: number }>>;
// The page's CSP has no unsafe-eval, so waitForFunction's string form can fail there: poll with evaluate instead.
const waitFor = async (page: any, expr: string, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await page.evaluate(expr)) return true; await page.waitForTimeout(100); } return false; };
const scroll = async (page: any) => page.evaluate(`({ w: innerWidth, s: document.documentElement.scrollWidth })`);
const openSettings = async (page: any) => {
  await page.goto(fx.base + "/settings/advanced"); await mounted(page, 30000);
  await page.waitForSelector("#settings-update .uc-machine", { timeout: 20000 }); await page.waitForTimeout(600);
  await page.evaluate(`document.querySelector("#settings-update .uc-machine")?.scrollIntoView({ block: "center" })`);
};

async function walk(c: any) {
  const tag = caseName(c), zh = c.lang === "zh-TW", phone = c.device === "phone";
  const FIX = W(zh, "Fix it for me", "幫我修正");
  const { page, ctx } = await fx.page(c, { path: "/settings/advanced" });
  const errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message));
  try {
    // 1 lingering off
    setPreflight(LINGER_OFF); fixTakes = true;
    await openSettings(page);
    let m = await machine(page), b = await fixButtons(page);
    check(`${tag} 1: lingering off: the line names the user, with its command as code`, m.includes("◐") && m.includes("example") && (await cmds(page)).join("|") === "sudo loginctl enable-linger example", m);
    check(`${tag} 1: one fix button, Fix it for me`, b.length === 1 && b[0]!.t === FIX, b);
    if (phone) check(`${tag} 1: the button is 44 px`, b.every((x) => x.h >= 44), b);
    check(`${tag} 1: the command on one line`, (await oneLine(page)).every((n) => n === 1), await oneLine(page));
    const sc = await scroll(page);
    check(`${tag} 1: no sideways scroll`, sc.s <= sc.w, sc);
    await shot(page, `${tag}-1-linger`);
    // 2 pressed: the fix runs once; the fresh pre-flight replaces the page's
    const before = fixes.length;
    await page.locator("#settings-update .uc-machine button").click();
    await waitFor(page, `((document.querySelector("#settings-update .uc-machine") || {}).innerText || "").includes("✓")`);
    m = await machine(page);
    check(`${tag} 2: the fix ran once`, fixes.length === before + 1 && fixes[fixes.length - 1] === "linger", fixes);
    check(`${tag} 2: ✓ AgEnD can update itself here; the line and its button are gone`, m.includes(W(zh, "AgEnD can update itself here.", "AgEnD 可以在這裡自行更新。")) && !m.includes("example") && (await fixButtons(page)).length === 0, m);
    check(`${tag} 2: says it's done, in full`, await toastWhole(page, W(zh, "Done: AgEnD keeps running after example signs out.", "完成：使用者 example 登出後，AgEnD 仍會繼續執行。")), await toasts(page));
    if (zh) check(`${tag} 2: the toast keeps 「執行」 whole`, await unsplit(page, "執行", ".toasts") === true, await unsplit(page, "執行", ".toasts"));
    await shot(page, `${tag}-2-fixed`);
    // 3 a fix that doesn't take
    setPreflight(LINGER_OFF); fixTakes = false;
    await openSettings(page);
    await page.locator("#settings-update .uc-machine button").click();
    await waitFor(page, `document.querySelectorAll(".toasts .toast.err").length > 0`);
    await page.waitForTimeout(300);
    m = await machine(page); b = await fixButtons(page);
    check(`${tag} 3: says AgEnD couldn't, and to run the command, in full`, await toastWhole(page, W(zh, "AgEnD couldn't fix it by itself. Run the command above in a terminal on that computer.", "AgEnD 無法自行修正。請在那台電腦的終端機執行上面的指令。")), await toasts(page));
    check(`${tag} 3: the line and its command stay; the button can be pressed again`, m.includes("example") && (await cmds(page)).join("|") === "sudo loginctl enable-linger example" && b.length === 1 && b[0]!.t === FIX, { m, b });
    if (zh) for (const w of ["上面", "終端機", "執行"]) check(`${tag} 3: the toast keeps 「${w}」 whole`, await unsplit(page, w, ".toasts") === true, await unsplit(page, w, ".toasts"));
    await shot(page, `${tag}-3-failed`);
    // 4 not a service: How to fix, no button
    setPreflight(NOT_SERVICE);
    await openSettings(page);
    check(`${tag} 4: no fix button`, (await fixButtons(page)).length === 0, await fixButtons(page));
    await page.locator("#settings-update .uc-machine details.uc-how summary").click(); await page.waitForTimeout(300);
    m = await machine(page);
    check(`${tag} 4: How to fix folds out agend install, as code, and says what it does`, (await cmds(page)).join("|") === "agend install"
      && m.includes(W(zh, "AgEnD restarts as a service: every Agent stops briefly and comes back on its own.", "AgEnD 會改以服務方式重新啟動：每個 Agent 會短暫停止，之後自動回來。")), m);
    check(`${tag} 4: the command on one line`, (await oneLine(page)).every((n) => n === 1), await oneLine(page));
    if (zh) for (const w of ["回來", "服務方式", "執行"]) check(`${tag} 4: 「${w}」 kept whole`, await unsplit(page, w) === true, await unsplit(page, w));
    const indent = await page.evaluate(`(() => { const s = document.querySelector("#settings-update .uc-checks .uc-how summary").getBoundingClientRect(), p = document.querySelector("#settings-update .uc-checks .uc-how > p"); return Math.round(p.getBoundingClientRect().left + parseFloat(getComputedStyle(p).paddingLeft) - s.left); })()`) as number;
    check(`${tag} 4: How to fix's steps indented under it`, indent >= 8, indent);
    const sc4 = await scroll(page);
    check(`${tag} 4: no sideways scroll`, sc4.s <= sc4.w, sc4);
    await shot(page, `${tag}-4-not-service`);
    check(`${tag}: no page errors`, errors.length === 0, errors);
  } finally { await ctx.close(); }
}

try {
  for (const c of matrix("desk-light-en,phone-dark-zh-TW")) await walk(c);
  check("nothing was installed: no launch reached", launches.length === 0, launches);
} finally {
  await fx.close();
  const failed = receipt.checks.filter((x: any) => !x.ok).length;
  receipt.summary = `${receipt.checks.length - failed}/${receipt.checks.length}`;
  writeFileSync(join(OUT, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(`checks ${receipt.summary}`);
  process.exitCode = failed ? 1 : 0;
}
