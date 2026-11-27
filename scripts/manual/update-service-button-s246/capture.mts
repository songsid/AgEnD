/**
 * M-3770 S-246 real-app captures (owned web fixture; no Fleet/CLI starts, accounts, npm or external services): the
 * Install as a service button in Settings → Version and update → "Updates on this machine", through the REAL route
 * (POST /ui/update/fixes) and the real FleetManager method behind it. Nothing on this host changes: the command itself
 * (`startServiceInstall`, which would run `agend install`) is stubbed before the first press, and every update launch too.
 *   1 not a service: the line, Install as a service, and How to fix · 2 pressed: the confirmation (what happens to the
 *   Agents) · 3 Cancel: nothing sent · 4 confirmed, refused: says why, and that AgEnD keeps running · 5 confirmed, the
 *   hand-over: Installing… (said in the check's block; the card's other buttons off), AgEnD gone for a moment (the browser's own requests fail), back as a
 *   service: ✓ and its toast. A refusal and the restart are said in the block, never a toast over the page (#4557 look).
 * Desk light en and phone dark zh-TW.
 *   CHROME=<chromium> PW_DIR=<playwright-core> REPO=<checkout> OUT=<dir> npx tsx scripts/manual/update-service-button-s246/capture.mts
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
  const path = `s246-${name}.png`;
  // The fleet.yaml preview shows the fixture's temporary folder (a path on the capturing host): masked in every frame.
  const leaks = await page.evaluate(`(() => { const t = document.body.innerText; const y = [...document.querySelectorAll(".s-yaml")].map((e) => e.innerText).join("\\n"); return [...t.matchAll(/\\/tmp\\/[^\\s]*/g)].map((m) => m[0]).filter((x) => !y.includes(x)); })()`) as string[];
  check(`${name}: no host path outside the masked fleet.yaml`, leaks.length === 0, leaks);
  await page.screenshot({ path: join(OUT, path), mask: [page.locator(".s-yaml")], maskColor: "#888888" });
  receipt.pictures.push({ path, sha256: createHash("sha256").update(readFileSync(join(OUT, path))).digest("hex") });
};

const fx = await bootFixture({ port: 0, classic: false, host: true, roster: [
  { name: "general", general: true, backend: "claude-code", displayName: "General", status: "running" },
  { name: "dev", backend: "claude-code", displayName: "Example helper", status: "running" },
] });
const fm = fx.fm;
// Nothing installs and nothing on this host changes: every launch path and the command itself are stubbed first.
const launches: string[] = [], installs: string[] = [];
fm.launchInstalledUpdate = async (origin: string) => { launches.push(origin); return null; };
fm.startWebUpdate = async () => { launches.push("web"); return { ok: false, status: 503, error: "capture_no_install" }; };
const { summarize } = await import(REPO + "/src/update-readiness.ts");
const pre = (checks: any[]) => summarize(checks, Date.now());
const ok = (id: string) => ({ id, ok: true });
const SERVICE = pre(["P1", "P2", "P3", "P4", "P5", "P8", "P9"].map(ok));
const NOT_SERVICE = pre([ok("P1"), ok("P2"), { id: "P3", ok: false, code: "not-service" }, ok("P4"), ok("P5"), ok("P8"), ok("P9")]);
const setPreflight = (p: any) => { fm.updatePreflight = p; fm.probeUpdatePreflight = async () => p; };
const REFUSAL = "The user's service manager can't be reached (Failed to connect to bus: No medium found).";
let outcome: "failed" | "restarting" = "failed";
fm.startServiceInstall = async () => {
  installs.push(outcome);
  if (outcome === "failed") return { kind: "failed", reason: REFUSAL };
  return { kind: "restarting" };
};
const current = fm.runningAgendVersion();
const NEXT = current.replace(/(\d+)$/, (n: string) => String(Number(n) + 1));
fm.recordUpdateCheck(current, { target: NEXT, fromChannel: true });
// The page looks again once AgEnD is back (POST /ui/update/check): answered here, never by the registry.
const lookups: string[] = [];
fm.lookUpUpdateTarget = async (v: string) => { lookups.push(v); return { target: NEXT, fromChannel: true }; };

const W = (zh: boolean, en: string, zhText: string) => (zh ? zhText : en);
const machine = async (page: any) => page.evaluate(`(document.querySelector("#settings-update .uc-machine") || {}).innerText || ""`) as Promise<string>;
const toasts = async (page: any) => page.evaluate(`[...document.querySelectorAll(".toasts .toast")].map((e) => e.innerText.trim())`) as Promise<string[]>;
const toastWhole = async (page: any, text: string) => page.evaluate(`[...document.querySelectorAll(".toasts .toast")].some((e) => e.innerText.trim() === ${JSON.stringify(text)} && e.scrollWidth <= e.clientWidth + 1 && getComputedStyle(e).textOverflow !== "ellipsis")`) as Promise<boolean>;
const buttons = async (page: any) => page.evaluate(`[...document.querySelectorAll("#settings-update .uc-machine button")].map((b) => ({ t: b.innerText.trim(), h: Math.round(b.getBoundingClientRect().height), disabled: b.disabled }))`) as Promise<Array<{ t: string; h: number; disabled: boolean }>>;
const dialog = async (page: any) => page.evaluate(`(() => { const d = document.querySelector("dialog.dlg[open]"); if (!d) return null;
  const r = d.getBoundingClientRect();
  return { text: d.innerText, buttons: [...d.querySelectorAll("button")].map((b) => ({ t: b.innerText.trim(), h: Math.round(b.getBoundingClientRect().height) })).filter((b) => b.t),
    bottom: Math.round(innerHeight - r.bottom), left: Math.round(r.left), right: Math.round(innerWidth - r.right) }; })()`);
// A word kept on one line: its text range's boxes share one top.
const unsplit = async (page: any, word: string, root: string) => page.evaluate(`(() => { const w = ${JSON.stringify(word)};
  const walk = document.createTreeWalker(document.querySelector(${JSON.stringify(root)}), NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) { const i = n.data.indexOf(w); if (i < 0) continue;
    const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + w.length);
    return new Set([...r.getClientRects()].filter((b) => b.width).map((b) => Math.round(b.top))).size === 1; }
  return null; })()`);
const waitFor = async (page: any, expr: string, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await page.evaluate(expr)) return true; await page.waitForTimeout(100); } return false; };
const scroll = async (page: any) => page.evaluate(`({ w: innerWidth, s: document.documentElement.scrollWidth })`);
const posts: any[] = [];
const openSettings = async (page: any) => {
  await page.goto(fx.base + "/settings/advanced"); await mounted(page, 30000);
  await page.waitForSelector("#settings-update .uc-machine", { timeout: 20000 }); await page.waitForTimeout(600);
  await page.evaluate(`document.querySelector("#settings-update .uc-machine")?.scrollIntoView({ block: "center" })`);
};
const press = async (page: any, label: string) => { await page.locator("#settings-update .uc-machine button", { hasText: label }).click(); await page.waitForTimeout(400); };

async function walk(c: any) {
  const tag = caseName(c), zh = c.lang === "zh-TW", phone = c.device === "phone";
  const IT = W(zh, "Install as a service", "安裝成服務"), GO = W(zh, "Install and restart", "安裝並重新啟動"), CANCEL = W(zh, "Cancel", "取消");
  const { page, ctx } = await fx.page(c, { path: "/settings/advanced" });
  const errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message));
  page.on("request", (r: any) => { if (r.url().endsWith("/ui/update/fixes")) posts.push({ tag, body: r.postDataJSON() }); });
  try {
    // 1 not a service
    setPreflight(NOT_SERVICE); outcome = "failed";
    await openSettings(page);
    let m = await machine(page), b = await buttons(page);
    check(`${tag} 1: not a service: the line, How to fix, and one button, Install as a service`, m.includes("◐") && m.includes(W(zh, "How to fix", "修正方式")) && b.length === 1 && b[0]!.t === IT, { m, b });
    if (phone) check(`${tag} 1: the button is 44 px`, b.every((x) => x.h >= 44), b);
    const sc = await scroll(page);
    check(`${tag} 1: no sideways scroll`, sc.s <= sc.w, sc);
    await shot(page, `${tag}-1-not-service`);
    // 2 pressed: asked first
    const sent = posts.length;
    await press(page, IT);
    const d = await dialog(page);
    check(`${tag} 2: asks first: the title, what happens to every Agent, and after`, !!d && d.text.includes(W(zh, "Install AgEnD as a service?", "要把 AgEnD 安裝成服務嗎？"))
      && d.text.includes(W(zh, "every agent stops briefly, then picks up its conversations again, and this page reconnects by itself.", "每個 Agent 會短暫停止，之後接著原本的對話繼續，這個頁面也會自動重新連線。"))
      && d.text.includes(W(zh, "AgEnD can bring itself back after an update.", "AgEnD 都能自己重新啟動。")) && d.text.includes("agend uninstall"), d);
    check(`${tag} 2: Install and restart, and Cancel`, !!d && [GO, CANCEL].every((t) => d.buttons.some((x: any) => x.t === t)), d);
    check(`${tag} 2: nothing sent yet`, posts.length === sent, posts);
    if (zh) for (const w of ["短暫停止", "自動回來", "重新啟動"]) check(`${tag} 2: 「${w}」 kept whole`, await unsplit(page, w, "dialog.dlg[open]") === true, await unsplit(page, w, "dialog.dlg[open]"));
    if (phone) check(`${tag} 2: a bottom sheet with 44 px buttons`, !!d && d.bottom <= 1 && d.left <= 1 && d.right <= 1 && d.buttons.every((x: any) => x.h >= 44), d);
    await shot(page, `${tag}-2-confirm`);
    // 3 Cancel: nothing sent, nothing ran
    const ran = installs.length;
    await page.locator("dialog.dlg[open] button", { hasText: CANCEL }).click(); await page.waitForTimeout(400);
    check(`${tag} 3: Cancel sends nothing and runs nothing`, posts.length === sent && installs.length === ran && !(await dialog(page)), { posts, installs });
    // 4 confirmed, refused
    await press(page, IT);
    await page.locator("dialog.dlg[open] button", { hasText: GO }).click();
    await waitFor(page, `!!document.querySelector("#settings-update .uc-fix-refused")`);
    await page.waitForTimeout(300);
    check(`${tag} 4: one POST, with the page's confirmation`, posts.length === sent + 1 && JSON.stringify(posts.at(-1).body) === JSON.stringify({ fix: "service", confirm: "restart-as-service" }), posts);
    m = await machine(page);
    check(`${tag} 4: the block says the cause in the product's words, the command's own words as a detail, and that AgEnD keeps running`,
      m.includes(W(zh, "AgEnD couldn't install the service: this computer's user service manager can't be reached. AgEnD keeps running as before. Details:", "AgEnD 無法安裝服務：這台電腦的使用者服務管理員無法連線。AgEnD 仍照原本的方式執行。詳細訊息："))
      && m.includes("Failed to connect to bus: No medium found"), m);
    check(`${tag} 4: the next step: the WSL fix, and when the button comes back`, m.includes(W(zh, "run wsl --update in Windows", "在 Windows 執行 wsl --update")) && m.includes(W(zh, "Check for updates", "檢查更新")), m);
    const chip = await page.evaluate(`(() => { const c = document.querySelector("#settings-update .uc-fix-refused .uc-cmd"); const box = document.querySelector("#settings-update .uc-machine").getBoundingClientRect(); return c ? { right: Math.round(c.getBoundingClientRect().right), edge: Math.round(box.right), over: c.scrollWidth > c.clientWidth + 1 } : null; })()`) as any;
    check(`${tag} 4: the raw words' chip stays inside the block (it wraps)`, !!chip && !chip.over && chip.right <= chip.edge, chip);
    check(`${tag} 4: no toast over the page`, (await toasts(page)).length === 0, await toasts(page));
    b = await buttons(page);
    check(`${tag} 4: the line stays; the button and How to fix (its agend install just failed) are gone`, m.includes("◐") && b.length === 0 && !m.includes(W(zh, "How to fix", "修正方式")), { m, b });
    await shot(page, `${tag}-4-refused`);
    // 5 confirmed, the hand-over: AgEnD answers, then is gone for a moment (two requests fail), then is back as a service
    await openSettings(page);
    outcome = "restarting";
    // AgEnD gone for 4 s: every request to it fails meanwhile (the page polls every 3 s, so it sees at least one).
    let goneUntil = 0;
    await page.route("**/ui/update", async (route: any) => (Date.now() < goneUntil ? route.abort("connectionrefused") : route.continue()));
    await press(page, IT);
    await page.locator("dialog.dlg[open] button", { hasText: GO }).click();
    await waitFor(page, `!!document.querySelector("#settings-update .uc-fix-refused")`);
    await page.waitForTimeout(300);
    b = await buttons(page); m = await machine(page);
    check(`${tag} 5: the block says AgEnD is installing and restarting; the button says Installing… and can't be pressed`, m.includes(W(zh, "AgEnD is installing the service and restarting. This page reconnects when it's back.", "AgEnD 正在安裝服務並重新啟動，回來後這個頁面會自動重新連線。"))
      && b.length === 1 && b[0]!.t === W(zh, "Installing…", "安裝中…") && b[0]!.disabled, { b, m });
    const rowOn = await page.evaluate(`[...document.querySelectorAll("#settings-update button")].filter((x) => !x.closest(".uc-machine") && !x.disabled && /${W(zh, "Update when idle|Check for updates|Pick a time|Not now", "閒置時更新|檢查更新|選個時間|先不要")}/.test(x.innerText)).map((x) => x.innerText.trim())`) as string[];
    check(`${tag} 5: the card's other buttons are off meanwhile`, rowOn.length === 0, rowOn);
    check(`${tag} 5: no How to fix while its agend install runs`, !m.includes(W(zh, "How to fix", "修正方式")), m);
    check(`${tag} 5: no toast over the page`, (await toasts(page)).length === 0, await toasts(page));
    await shot(page, `${tag}-5-restarting`);
    goneUntil = Date.now() + 4000; setPreflight(SERVICE);                     // the new fleet: a service now
    const back = await waitFor(page, `[...document.querySelectorAll(".toasts .toast")].some((e) => e.innerText.includes(${JSON.stringify(W(zh, "running as a service", "以服務方式執行"))}))`, 20000);
    await page.waitForTimeout(400);
    m = await machine(page);
    check(`${tag} 5b: back: says so, in full; the line is ✓ and its button gone`, back && await toastWhole(page, W(zh, "AgEnD is back, running as a service.", "AgEnD 回來了，現在以服務方式執行。"))
      && m.includes("✓") && (await buttons(page)).length === 0, { m, t: await toasts(page) });
    check(`${tag} 5b: the restarting line is gone`, !m.includes(W(zh, "installing the service and restarting", "安裝服務並重新啟動")), m);
    await page.unroute("**/ui/update");
    // A phone's toast sits over the page's top: the frame is taken once it has gone (its words are checked above).
    if (phone) { const gone = await waitFor(page, `document.querySelectorAll(".toasts .toast").length === 0`, 20000); check(`${tag} 5b: the toast has gone before the frame`, gone, await toasts(page)); }
    await shot(page, `${tag}-5b-back`);
    check(`${tag}: no page errors`, errors.length === 0, errors);
  } finally { await ctx.close(); }
}

try {
  for (const c of matrix("desk-light-en,phone-dark-zh-TW")) await walk(c);
  check("nothing was installed: no launch reached", launches.length === 0, launches);
  // The second case's look is refused by the route's one-a-minute limit (the same fixture); its page reads the fresh
  // pre-flight all the same. Every look there was answered here.
  check("the look again after the hand-over was answered locally (no registry)", lookups.length >= 1, lookups);
  check("the command ran only once confirmed: refused, then the hand-over, per case", JSON.stringify(installs) === JSON.stringify(["failed", "restarting", "failed", "restarting"]), installs);
} finally {
  await fx.close();
  const failed = receipt.checks.filter((x: any) => !x.ok).length;
  receipt.summary = `${receipt.checks.length - failed}/${receipt.checks.length}`;
  writeFileSync(join(OUT, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(`checks ${receipt.summary}`);
  process.exitCode = failed ? 1 : 0;
}
