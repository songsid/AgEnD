// Refs #3061, review of #3165: browser evidence for the three new paths — signing a new device in with its code (sign-in page), the device
// list and its Add device approval (Settings → Access & security), and the authenticator set-up dialog — in two directions each:
//   fresh — this checkout's UI against this checkout's endpoints;
//   stale — a tab opened BEFORE the upgrade (BASE's files, served from git) talking to this checkout's endpoints: the sign-in page's old
//           script, the old shell (stale-shell) with the new Settings panel, the old Settings modules (old-page) and the old Session menu.
// A one-time local fixture (a web-only fleet in a scratch home on 127.0.0.1), English UI. Nothing real is on screen or in the output: the
// 8-character code, the authenticator key and its QR code are redacted in every screenshot (in the page, before the shot) and never printed; the receipt
// names only paths and status codes. The redaction checks itself: every target it is told about must exist (the QR's modules too, which draw after the
// key), is verified redacted before AND after the shot, and a page-wide scan (key, code, otpauth URI, a QR painted by the app, this machine's hostname)
// must find nothing — on every screenshot, those with no target included. Afterwards every screenshot is decoded with jsQR (both polarities): one that
// still decodes as a QR code fails the run, and a canary (an unredacted screenshot, taken to a temp file and deleted) must decode, or the check cannot see.
// The authenticator's account label is the machine's hostname in the product (fleet-manager: hostname()); here it is replaced with a fixed fake one.
// Two of the steps are controls: the sign-in script and the authenticator card as they were before the review fixes (PRE_FIX, default cd7f378b) run the
// same orders and must show the two races (an approved new attempt reads "expired"; the code from the key on screen is refused). BASE (default: the merge-base
// with upstream/release/2.3.5-alpha) is where the old tab's files come from. Run it on a clean checkout of the commit to be judged: the receipt says whether it was.
//   PW_DIR=<dir with playwright-core> QR_DIR=<dir whose node_modules has jsqr and pngjs> CHROME=<chrome> REPO=<checkout> OUT=<dir> [BASE=<ref>] [PRE_FIX=<ref>] \
//     FONTCONFIG_FILE=/etc/fonts/fonts.conf npx --prefix <checkout> tsx scripts/manual/smoke/smoke-access-evidence-3061.mts
// Without QR_DIR the screenshots are not decoded and the run FAILS (they must not be published unchecked).
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { hostname as realHostname, tmpdir } from "node:os";
import { join } from "node:path";
import { bootFixture, shotPath } from "../smoke-fixture/index.mts";

// The product labels the authenticator account with this machine's hostname, and the QR code carries it. The fixture gets a fixed fake one, set before the
// fleet is imported; the real one is kept only to be searched for (it must be in no page text, and never in the otpauth label).
const REAL_HOST = realHostname(), FIXTURE_HOST = "fixture-host";
(createRequire(import.meta.url)("node:os") as { hostname: () => string }).hostname = () => FIXTURE_HOST;
syncBuiltinESMExports();

const SMOKE = "smoke-access-evidence-3061";
const REPO = process.env.REPO ?? process.cwd();
const OUT = join(process.env.OUT ?? "/tmp/smoke-out", SMOKE);
mkdirSync(OUT, { recursive: true });
for (const f of readdirSync(OUT)) if (/^evidence-.*\.png$/.test(f)) rmSync(join(OUT, f));      // never judge (or publish) a screenshot from an earlier run
const git = (...a: string[]) => execFileSync("git", ["-C", REPO, ...a], { encoding: "utf8", maxBuffer: 64 << 20 });
const BASE = process.env.BASE ?? git("merge-base", "HEAD", "upstream/release/2.3.5-alpha").trim();
const head = git("rev-parse", "HEAD").trim(), dirty = git("status", "--porcelain").trim();
// The last commit before the review fixes (#3165 at cd7f378b): the controls run its sign-in script and its authenticator card to show the two races the fixes remove.
const PRE_FIX = process.env.PRE_FIX ?? "cd7f378b";
const atBase = (p: string) => spawnSync("git", ["-C", REPO, "cat-file", "-e", `${BASE}:${p}`]).status === 0;
const oldBody = (p: string) => git("show", `${BASE}:${p}`);
const changed = git("diff", "--name-only", BASE, "HEAD", "--", "src/ui").split("\n").filter(Boolean).filter(p => /^src\/ui\/(shared\/)?[a-z0-9._-]+\.(js|css)$/.test(p));
const shared = (p: string) => p.startsWith("src/ui/shared/");
const urlOf = (p: string) => (shared(p) ? `/assets/${p.slice("src/ui/shared/".length)}` : `/ui/js/${p.slice("src/ui/".length)}`);
const SHELL_ALWAYS = ["app.js", "app-shell.js", "app-stream.js", "app.css", "instance-nav.js"].map(f => `src/ui/shared/${f}`);
const staleShell = [...new Set([...SHELL_ALWAYS, ...changed.filter(shared)])].filter(atBase);
const oldPage = changed.filter(p => !shared(p) && atBase(p));

const fx = await bootFixture({ port: Number(process.env.HP ?? 48961), classic: false, instances: 3, webYaml: "  verified_authority:\n    enabled: true" });
const fm = fx.fm as any;
const { hotp, base32Decode, totpStep } = await import(`${REPO}/src/web-remote-access.ts`);
const token = fm.getDashboardAccess().token as string;
const hostCode = async () => (await (await fetch(`${fx.base}/auth/issue-code`, { method: "POST", headers: { "x-agend-token": token, origin: fx.base } })).json()).code as string;
fm.webPrefs.write("operator", new Map<string, unknown>([["theme", "light"], ["lang", "en"]]));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
// jsQR + pngjs live outside the repo (QR_DIR): the screenshots are decoded with them at the end.
let decodesAsQr: ((file: string) => boolean) | null = null;
if (process.env.QR_DIR) {
  const req = createRequire(join(process.env.QR_DIR, "noop.js")), jsQR = req("jsqr"), { PNG } = req("pngjs");
  decodesAsQr = (file: string) => { const png = PNG.sync.read(readFileSync(file)); return !!jsQR(new Uint8ClampedArray(png.data), png.width, png.height, { inversionAttempts: "attemptBoth" }); };
}
let canaryDecoded: boolean | null = null, accountLabel: string | null = null, labelLeak = false;

type Row = { path: string; direction: "fresh" | "stale"; step: string; ok: boolean; detail: string; shots: string[] };
const rows: Row[] = [];
const net: string[] = [];                                    // "METHOD path → status" lines for the new endpoints (never a body, never a cookie)
async function context(opts: { phone?: boolean } = {}) {
  const ctx = await fx.browser.newContext({ viewport: opts.phone ? { width: 390, height: 844 } : { width: 1366, height: 900 }, locale: "en-US" });
  await ctx.addInitScript({ content: `try { localStorage.setItem("agend_tour_done","1"); localStorage.setItem("agend_firstrun_dismissed","1"); localStorage.setItem("agend_lang","en"); } catch {}` });
  return ctx;
}
function watch(page: any, errors: string[]) {
  page.on("pageerror", (e: any) => errors.push(String(e)));
  page.on("console", (m: any) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`); });
  page.on("response", (r: any) => {
    const u = new URL(r.url());
    if (r.request().method() === "POST" && u.pathname === "/ui/outside/enroll") {         // only the account label of the otpauth URI is kept — never the key
      r.json().then((b: any) => { const m = /^otpauth:\/\/totp\/([^?]*)\?/.exec(String(b?.uri ?? "")); const label = m ? decodeURIComponent(m[1]!) : null; if (label) accountLabel = label.replace(/^[^:]*:/, ""); if (label && label.toLowerCase().includes(REAL_HOST.toLowerCase())) labelLeak = true; }).catch(() => {});
    }
    if (/^\/(auth\/(device-login|login|sessions|session)|ui\/(devices|outside))/.test(u.pathname)) net.push(`${r.request().method()} ${u.pathname.replace(/\/[0-9a-f]{16}$/, "/<handle>")} → ${r.status()}`);
  });
}
const swap = async (ctx: any, files: readonly string[]) => { for (const p of files) { const url = urlOf(p), body = oldBody(p); await ctx.route(`**${url}*`, (r: any) => r.fulfill({ status: 200, contentType: url.endsWith(".css") ? "text/css" : "text/javascript", body })); } };
const signInHost = async (page: any) => { await page.goto(`${fx.base}/signin`); await page.waitForSelector("#code"); await page.fill("#code", await hostCode()); await page.click("#go"); await page.waitForURL(`${fx.base}/ui`); };
// A modal <dialog> is drawn in the browser's top layer, above anything Playwright's `mask` paints — so the secrets are redacted in the page itself before
// the shot and put back after: text nodes keep their node (only .data changes, so the app's own updates still land), an input's value is restored, and
// the QR code's modules are emptied. What was on screen is never written anywhere.
// A target is "kind:selector" — text (a code or key shown as text), input (a field the person types into), qr (the app's SVG QR code). Each one must be there
// (and a QR must have drawn its modules: it is painted after the key, once its encoder has loaded) — an absent target is an error, not a skipped redaction.
// (The sources below are plain JS passed as strings, with the targets as the argument — never spliced into them: the test runner's transpiler would add
// helpers the page does not have.)
const REDACT_SOURCE = `(targets) => {
  const undo = [], problems = [];
  const bullets = (s) => s.replace(/[A-Za-z0-9]/g, "\\u2022");
  for (const { kind, sel } of targets) {
    const els = Array.from(document.querySelectorAll(sel));
    if (!els.length) { problems.push("target " + sel + " is not on the page"); continue; }
    for (const el of els) {
      if (kind === "input") { const v = el.value; if (v) { el.value = "\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022"; undo.push(() => { el.value = v; }); } }
      else if (kind === "qr") {
        const rect = el.querySelector("rect"), path = el.querySelector("path"), d = path ? path.getAttribute("d") || "" : "";
        if (d.length < 100) { problems.push("the QR " + sel + " has not drawn its modules"); continue; }
        path.setAttribute("d", ""); undo.push(() => path.setAttribute("d", d));
        if (rect) { const f = rect.getAttribute("fill"); rect.setAttribute("fill", "#9a9a9a"); undo.push(() => rect.setAttribute("fill", f || "#fff")); }
      } else {
        if (!/[A-Za-z0-9]/.test(el.textContent || "")) problems.push("the text " + sel + " has nothing in it to redact");
        const walk = (n) => { for (const c of Array.from(n.childNodes)) { if (c.nodeType === 3) { const old = c.data; c.data = bullets(old); undo.push(() => { c.data = old; }); } else walk(c); } };
        walk(el);
      }
    }
  }
  window.__undoRedact = () => { while (undo.length) undo.pop()(); };
  return { problems };
}`;
// What must be true of the page at the moment of the shot (and again right after it): every target redacted, and nothing secret-looking anywhere on the page.
const CHECK_SOURCE = `(targets, host) => {
  const problems = [];
  for (const { kind, sel } of targets) {
    const els = Array.from(document.querySelectorAll(sel));
    if (!els.length) { problems.push("target " + sel + " is not on the page"); continue; }
    for (const el of els) {
      if (kind === "input") { if (/[A-Za-z0-9]/.test(el.value || "")) problems.push("the field " + sel + " still shows its value"); }
      else if (kind === "qr") { const path = el.querySelector("path"); if (!path || (path.getAttribute("d") || "") !== "") problems.push("the QR " + sel + " still has its modules"); }
      else if (/[A-Za-z0-9]/.test(el.textContent || "")) problems.push("the text " + sel + " still shows letters or digits");
    }
  }
  const inputs = Array.from(document.querySelectorAll("input, textarea")).map((e) => e.value || "");
  const hay = [document.body ? document.body.innerText : "", ...inputs].join("\\n");
  if (/[A-Z2-7]{4}(?: [A-Z2-7]{4}){7}/.test(hay) || /\\b[A-Z2-7]{32}\\b/.test(hay)) problems.push("a 32-character key is on the page");
  if (/\\b(?!XXXX-XXXX\\b)[A-Z0-9]{4}-[A-Z0-9]{4}\\b/.test(hay)) problems.push("an 8-character code is on the page");
  if (/otpauth:\\/\\//i.test(hay) || /secret=[A-Z2-7]/i.test(hay)) problems.push("an otpauth URI is on the page");
  if (inputs.some((v) => /^\\s*\\d{3}\\s?\\d{3}\\s*$/.test(v))) problems.push("a 6-digit code is in a field");
  if (host && hay.toLowerCase().includes(host.toLowerCase())) problems.push("this machine's hostname is on the page");
  for (const path of Array.from(document.querySelectorAll("svg path"))) if (/^(M\\d+ \\d+h1v1h-1z){20,}/.test(path.getAttribute("d") || "")) { problems.push("a QR code painted by the app is on the page"); break; }
  return problems;
}`;
const redactionLog: string[] = [];
const QR_SET = ["qr:#outQr", "text:#outKey", "input:#outCode"];
const shot = async (page: any, name: string, targets: string[] = [], full = false) => {
  const path = shotPath(SMOKE, "evidence", name);
  const specs = targets.map(t => ({ kind: t.slice(0, t.indexOf(":")), sel: t.slice(t.indexOf(":") + 1) }));
  for (const { kind, sel } of specs) {
    if (kind === "qr") await page.waitForFunction((q: string) => { const p = document.querySelector(q + " path"); return !!p && (p.getAttribute("d") || "").length > 100; }, sel, { timeout: 15000 });
    else await page.waitForSelector(sel, { state: "attached", timeout: 15000 });
  }
  await page.evaluate(`window.__redact = ${REDACT_SOURCE}; window.__check = ${CHECK_SOURCE};`);
  const done = await page.evaluate((t: unknown) => (window as any).__redact(t), specs);
  if (!done || !Array.isArray(done.problems)) throw new Error(`redaction did not run for ${name}`);       // it must answer: silence is not "nothing to redact"
  let problems: string[] = [...done.problems, ...(await page.evaluate((a: unknown[]) => (window as any).__check(a[0], a[1]), [specs, REAL_HOST]))];
  try {
    if (!problems.length) {
      await page.screenshot({ path, fullPage: full });
      problems = await page.evaluate((a: unknown[]) => (window as any).__check(a[0], a[1]), [specs, REAL_HOST]);   // …and again right after: nothing new drew in meanwhile
    }
  } finally { await page.evaluate("window.__undoRedact && window.__undoRedact()"); }
  if (problems.length) { rmSync(path, { force: true }); throw new Error(`${name}: ${problems.join("; ")}`); }
  redactionLog.push(`${name}: ${specs.length ? specs.map(t => `${t.kind}:${t.sel}`).join(", ") : "no target"} — redaction verified before and after the shot; page scan clean`);
  return `${SMOKE}/evidence-${name}.png`;
};
async function run(path: string, direction: "fresh" | "stale", step: string, fn: () => Promise<{ detail: string; shots?: string[] } | void>) {
  try { const r = (await fn()) ?? { detail: "" }; rows.push({ path, direction, step, ok: true, detail: r.detail, shots: r.shots ?? [] }); console.log(`PASS ${path} / ${direction} / ${step}${r.detail ? ` — ${r.detail}` : ""}`); }
  catch (e) { rows.push({ path, direction, step, ok: false, detail: String(e).slice(0, 300), shots: [] }); console.log(`FAIL ${path} / ${direction} / ${step} — ${String(e).slice(0, 300)}`); }
}
const must = (cond: unknown, what: string) => { if (!cond) throw new Error(what); };
const goSettings = async (page: any, section: string, waitFor: string) => {
  await page.evaluate((p: string) => { history.pushState(null, "", p); dispatchEvent(new PopStateEvent("popstate")); }, `/settings/${section}`);
  await page.waitForSelector(waitFor, { timeout: 20000 });
  await sleep(500);
};

const errors: string[] = [];
const A = "Sign-in page (new device shows a code)", B = "Device list and Add device approval", C = "Authenticator set-up dialog";

// ───────── A, stale: an old sign-in page (BASE's script) against the new endpoints ─────────
{
  const ctx = await context(); await swap(ctx, ["src/ui/shared/signin.js"]);
  const page = await ctx.newPage(); watch(page, errors);
  await run(A, "stale", "old sign-in tab: no \"another device\" button; a host code still signs in through /auth/login", async () => {
    const calls: string[] = []; page.on("request", (r: any) => { const u = new URL(r.url()); if (u.pathname.startsWith("/auth/")) calls.push(`${r.method()} ${u.pathname}`); });
    await page.goto(`${fx.base}/signin`); await page.waitForSelector("#code");
    await page.waitForSelector("#form:not([hidden])");
    must(await page.locator("#another").isHidden(), "the old script showed the new-device button");
    const s1 = await shot(page, "A-stale-old-signin-script-form");
    await page.fill("#code", await hostCode()); await page.click("#go"); await page.waitForURL(`${fx.base}/ui`);
    must(!calls.some(c => c.includes("/auth/device-login")), `the old script called a device-login route: ${calls.join(", ")}`);
    return { detail: `old signin.js: form shown, button hidden, POST /auth/login → /ui; /auth/device-login* never called`, shots: [s1] };
  });
  await ctx.close();
}

/** The code on the new device's screen once it is a real one (not the placeholder) and the countdown line is up. */
const waitCode = async (page: any) => {
  await page.waitForFunction(() => { const c = document.getElementById("devCode")?.textContent ?? ""; return c !== "XXXX-XXXX" && /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(c) && (document.getElementById("devStatus")?.textContent ?? "") !== ""; }, null, { timeout: 15000 });
  return ((await page.locator("#devCode").textContent()) ?? "").trim();
};
/** The owner's side: Settings → Access & security → Add device → code → Allow. */
async function approveViaUi(ownerPage: any, code: string) {
  await goSettings(ownerPage, "access", "#devicesCard");
  await ownerPage.click("#devicesAdd"); await ownerPage.waitForSelector("#devCodeInput");
  await ownerPage.fill("#devCodeInput", code); await ownerPage.click("#devFind");
  await ownerPage.waitForSelector("#devFacts, #devMsg", { timeout: 15000 });
  if (await ownerPage.locator("#devMsg").count()) throw new Error("the owner's Find did not find the code");
  await ownerPage.click("#devAllow"); await ownerPage.waitForSelector("#devDone"); await ownerPage.click("#devDoneBtn");
}
/**
 * The review's race, in a browser: attempt A is cancelled with Back while the cancel is slow (held 1.5 s before it reaches the server, so its
 * Set-Cookie answer comes late), and a new attempt B starts at once; the owner approves B. Fixed: B waits for A's cancel, keeps its cookie
 * and signs in. Before the fix: B is asked for at once, A's late answer expires B's cookie, and B reads "expired" although it was approved.
 */
async function backThenNewWhileCancelIsSlow(page: any, ownerPage: any, name: string): Promise<{ outcome: "signed-in" | "expired"; shot: string }> {
  await page.goto(`${fx.base}/signin`); await page.waitForSelector("#another:not([hidden])");
  await page.click("#another"); await waitCode(page);
  await page.route("**/auth/device-login/cancel", async (r: any) => { await sleep(1500); await r.continue(); }, { times: 1 });
  await page.click("#devBack"); await page.waitForSelector("#form:not([hidden])");
  await page.click("#another");
  const code = await waitCode(page);                        // B's code (the fixed page shows it once A's cancel has finished)
  await approveViaUi(ownerPage, code);
  const outcome = await Promise.race([
    page.waitForURL(`${fx.base}/ui`, { timeout: 15000 }).then(() => "signed-in" as const),
    page.waitForFunction(() => /expired/i.test(document.getElementById("devStatus")?.textContent ?? ""), null, { timeout: 15000 }).then(() => "expired" as const),
  ]);
  return { outcome, shot: await shot(page, name, outcome === "expired" ? ["text:#devCode"] : []) };
}

// ───────── A + B, fresh: a new device asks for a code; the owner approves it in Settings → Add device ─────────
let newDevice: { ctx: any; page: any } | null = null;
{
  const owner = await context(), ownerPage = await owner.newPage(); watch(ownerPage, errors);
  await signInHost(ownerPage);
  const ctxNew = await context(), page = await ctxNew.newPage(); watch(page, errors);
  let code = "";
  await run(A, "fresh", "a new device asks for a code (shown, redacted here), with a countdown", async () => {
    await page.goto(`${fx.base}/signin`); await page.waitForSelector("#another:not([hidden])");
    await page.click("#another"); await page.waitForFunction(() => { const c = document.getElementById("devCode")?.textContent ?? ""; return c !== "XXXX-XXXX" && /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(c) && (document.getElementById("devStatus")?.textContent ?? "") !== ""; });
    code = (await page.locator("#devCode").textContent())!.trim();
    const status = ((await page.locator("#devStatus").textContent()) ?? "").trim();
    must(/^Waiting for approval… Expires in \d:\d\d\.$/.test(status), `status line: ${status}`);
    return { detail: `code shown (redacted); "${status.replace(/\d:\d\d/, "m:ss")}"`, shots: [await shot(page, "A-fresh-new-device-code", ["text:#devCode"])] };
  });
  await run(B, "fresh", "the owner opens Add device, enters the code, sees who is asking, and allows it", async () => {
    await ownerPage.goto(`${fx.base}/ui`); await goSettings(ownerPage, "access", "#devicesCard");
    await ownerPage.click("#devicesAdd"); await ownerPage.waitForSelector("#devCodeInput");
    await ownerPage.fill("#devCodeInput", code); await ownerPage.click("#devFind");
    await ownerPage.waitForSelector("#devFacts, #devMsg", { timeout: 15000 });
    if (await ownerPage.locator("#devMsg").count()) throw new Error(`Find answered: «${((await ownerPage.locator("#devMsg").textContent()) ?? "").trim()}»; requests: ${net.filter(l => l.includes("/ui/devices")).join(" | ")}`);
    const from = ((await ownerPage.locator("#devFrom").textContent()) ?? "").trim();
    must(!(await ownerPage.locator("#devCodeShown").isHidden()), "no code to compare on the confirm screen");
    const s1 = await shot(ownerPage, "B-fresh-confirm-who-is-asking", ["text:#devCodeShown"]);
    await ownerPage.click("#devAllow"); await ownerPage.waitForSelector("#devDone");
    const done = ((await ownerPage.locator("#devDone").textContent()) ?? "").trim();
    await ownerPage.click("#devDoneBtn");
    return { detail: `confirm screen: from «${from}», address, code to compare (redacted), device label; after Allow: «${done}»`, shots: [s1] };
  });
  await run(A, "fresh", "the new device signs itself in (its own poll) and lands in the app", async () => {
    await page.waitForURL(`${fx.base}/ui`, { timeout: 15000 });
    await page.waitForSelector(".session .side-row", { timeout: 15000 });
    return { detail: "POST /auth/device-login/poll → approved → /ui", shots: [await shot(page, "A-fresh-new-device-signed-in")] };
  });
  await run(B, "fresh", "the device list shows both devices, how each was approved, and the new one can be signed out by the owner", async () => {
    await ownerPage.click("#devicesRefresh"); await sleep(600);
    const list = ((await ownerPage.locator("#devicesList").innerText()) ?? "").replace(/\s+/g, " ").trim();
    must((await ownerPage.locator("#devicesList li").count()) >= 2, `devices listed: ${list.slice(0, 160)}`);
    return { detail: `${await ownerPage.locator("#devicesList li").count()} devices: «${list.slice(0, 180)}»`, shots: [await shot(ownerPage, "B-fresh-device-list", [], true)] };
  });
  newDevice = { ctx: ctxNew, page };
  await owner.close();
}

// ───────── A, race (fresh) and its control: Back, then a new attempt, while the cancel is slow ─────────
{
  const owner = await context(), ownerPage = await owner.newPage(); watch(ownerPage, errors);
  await signInHost(ownerPage);
  {
    const ctx = await context(), page = await ctx.newPage(); watch(page, errors);
    await run(A, "fresh", "Back, then a new attempt while the cancel is slow: the new attempt keeps its cookie, and the owner's approval signs it in", async () => {
      const r = await backThenNewWhileCancelIsSlow(page, ownerPage, "A-fresh-race-back-then-new-signed-in");
      must(r.outcome === "signed-in", `the approved new attempt ended as «${r.outcome}»`);
      return { detail: "slow POST /auth/device-login/cancel (1.5 s), new code requested at once → approved → signed in", shots: [r.shot] };
    });
    await ctx.close();
  }
  {
    const ctx = await context();
    const body = git("show", `${PRE_FIX}:src/ui/shared/signin.js`);
    await ctx.route("**/assets/signin.js*", (r: any) => r.fulfill({ status: 200, contentType: "text/javascript", body }));
    const page = await ctx.newPage(); watch(page, errors);
    await run(A, "stale", "control — the sign-in script before the race fix, same order: A's late cancel answer expires B's cookie, and the approved B reads \"expired\"", async () => {
      const r = await backThenNewWhileCancelIsSlow(page, ownerPage, "A-control-before-fix-approved-but-expired");
      must(r.outcome === "expired", `the control ended as «${r.outcome}» (it should reproduce the race)`);
      return { detail: "same steps → «This code has expired.» after the owner approved it (the review's finding, reproduced)", shots: [r.shot] };
    });
    await ctx.close();
  }
  await owner.close();
}

// ───────── B, stale: (1) the old shell with the new Settings panel; (2) the old Session menu on the device-approved session ─────────
{
  const ctx = await context(); await swap(ctx, staleShell);
  const page = await ctx.newPage(); watch(page, errors);
  await run(B, "stale", "old shell + new Settings panel (stale-shell): the Devices & sign-in card renders and its endpoints answer", async () => {
    await signInHost(page);
    const hasRule = await page.evaluate(() => [...document.styleSheets].some(s => { try { return [...s.cssRules].some((r: any) => (r.selectorText ?? "").includes(".s-devices")); } catch { return false; } }));
    must(!hasRule, "the shell is not stale: the loaded stylesheet already has .s-devices");
    await goSettings(page, "access", "#devicesCard");
    const rowsN = await page.locator("#devicesList li").count();
    must(rowsN >= 1, "no devices listed");
    return { detail: `app.css is BASE's (no .s-devices rule); card rendered, ${rowsN} device(s) listed from GET /ui/devices`, shots: [await shot(page, "B-stale-shell-devices-card", [], true)] };
  });
  await ctx.close();
}
if (newDevice) {
  const ctx = newDevice.ctx; await swap(ctx, ["src/ui/shared/app-session.js"]);
  const page = await ctx.newPage(); watch(page, errors);
  await run(B, "stale", "old Session menu (BASE's app-session.js) in the device-approved session: it offers Sign out for another device; the new endpoint refuses and the menu says so", async () => {
    await page.goto(`${fx.base}/ui`); await page.waitForSelector(".session .side-row");
    await page.click(".session .side-row"); await page.waitForSelector(".session .pop");
    await page.waitForSelector(".session .pop .devices li", { timeout: 10000 });
    const others = page.locator(".session .pop .devices li button.danger");
    must((await others.count()) >= 1, "the old menu offered no per-device Sign out");
    const before = net.length;
    await others.first().click(); await sleep(800);
    const calls = net.slice(before).filter(l => l.startsWith("DELETE /auth/sessions"));
    must(calls.length === 1 && /→ 403$/.test(calls[0]!), `DELETE answers: ${calls.join(" | ") || "none"}`);
    must(await page.locator(".session .pop .err").isVisible(), "the old menu did not show its error");
    return { detail: `${calls[0]} (a session a device approval made may sign itself out, not another); the old menu shows its failure line and stays usable`, shots: [await shot(page, "B-stale-old-session-menu-refused")] };
  });
  await ctx.close();
}

// ───────── C, stale: the old Settings modules (old-page) set up the authenticator through the new endpoints ─────────
let enrolled = false;
{
  const ctx = await context(); await swap(ctx, oldPage);
  const page = await ctx.newPage(); watch(page, errors);
  await run(C, "stale", "old-page (new shell + BASE's Settings modules): the old inline set-up still works against /ui/outside/enroll and /confirm", async () => {
    await signInHost(page);
    await goSettings(page, "access", "#outsideCard");
    must((await page.locator(".s-devices, #devicesCard").count()) === 0, "this is not the old page: it has the Devices card");
    await page.click("#outSetUp"); await page.waitForSelector("#outKey");
    must((await page.locator("dialog[open]").count()) === 0, "the old page opened a dialog");
    const s1 = await shot(page, "C-stale-old-page-inline-setup", QR_SET);
    const key = ((await page.locator("#outKey").textContent()) ?? "").replace(/\s/g, "");
    await page.fill("#outCode", hotp(base32Decode(key)!, totpStep(Date.now())));
    await page.click("#outConfirm"); await page.waitForSelector("#outSetUpOn", { timeout: 10000 });
    enrolled = true;
    return { detail: "old inline block (no dialog): key + QR (redacted) → code accepted by the new endpoint → \"set up\"", shots: [s1] };
  });
  await ctx.close();
}

/** Set up again with the FIRST /ui/outside/enroll request held in the browser for 1.5 s; Cancel (Esc, after a person's pause) and open again; then the code of the key on screen. */
async function slowFirstThenReopen(page: any): Promise<{ asked: number; outcome: "confirmed" | "refused" }> {
  await page.route("**/ui/outside/enroll", async (r: any) => { await sleep(1500); await r.continue(); }, { times: 1 });
  const before = net.length;
  await goSettings(page, "access", "#outsideCard");
  await page.click("#outAgain"); await page.waitForSelector("dialog[open]");
  await sleep(400); await page.keyboard.press("Escape"); await page.waitForSelector("dialog[open]", { state: "detached" });
  await page.click("#outAgain"); await page.waitForSelector("dialog[open] #outKey", { timeout: 15000 });
  await sleep(2200);                                   // by now the slow first request has reached the server, whichever order it came in
  const asked = net.slice(before).filter(l => l.startsWith("POST /ui/outside/enroll →")).length;
  const key = ((await page.locator("#outKey").textContent()) ?? "").replace(/\s/g, "");
  await page.fill("#outCode", hotp(base32Decode(key)!, totpStep(Date.now())));
  await page.click("#outConfirm");
  const outcome = await Promise.race([
    page.waitForSelector("dialog[open]", { state: "detached", timeout: 10000 }).then(() => "confirmed" as const),
    page.waitForSelector("#outMsg", { timeout: 10000 }).then(() => "refused" as const),
  ]);
  if (outcome === "refused") { await shot(page, "C-control-before-fix-code-refused", QR_SET); await page.click("#outCancel"); }
  return { asked, outcome };
}

// ───────── C, fresh: the dialog ─────────
{
  const ctx = await context(), page = await ctx.newPage(); watch(page, errors);
  await signInHost(page);
  await run(C, "fresh", `the set-up dialog (${enrolled ? "Set up again" : "Set up authenticator app"}): steps 1 and 2, the key and QR (redacted), a wrong code is answered inside it, a right one turns it on`, async () => {
    await goSettings(page, "access", "#outsideCard");
    await page.click(enrolled ? "#outAgain" : "#outSetUp"); await page.waitForSelector("dialog[open] #outKey");
    const title = ((await page.locator("dialog[open] .dlg-title").textContent()) ?? "").trim();
    // The canary: this very dialog, unredacted, to a temp file that is deleted at once — the QR decoder must read it, or its "no QR" on the evidence means nothing.
    await page.waitForFunction(() => { const p = document.querySelector("#outQr path"); return !!p && (p.getAttribute("d") || "").length > 100; }, null, { timeout: 15000 });
    if (decodesAsQr) { const dir = mkdtempSync(join(tmpdir(), "qr-canary-")); try { const f = join(dir, "canary.png"); await page.screenshot({ path: f }); canaryDecoded = decodesAsQr(f); } finally { rmSync(dir, { recursive: true, force: true }); } }
    const s1 = await shot(page, "C-fresh-dialog-open", QR_SET);
    await page.fill("#outCode", "000000"); await page.click("#outConfirm"); await page.waitForSelector("#outMsg");
    const wrong = ((await page.locator("#outMsg").textContent()) ?? "").trim();
    must(/didn't work/.test(wrong) && (await page.locator("dialog[open]").count()) === 1, `wrong code: «${wrong}»`);
    const s2 = await shot(page, "C-fresh-dialog-wrong-code", QR_SET);
    const key = ((await page.locator("#outKey").textContent()) ?? "").replace(/\s/g, "");
    await page.fill("#outCode", hotp(base32Decode(key)!, totpStep(Date.now())));
    await page.click("#outConfirm"); await page.waitForSelector("dialog[open]", { state: "detached", timeout: 10000 });
    must(((await page.locator("#outState").textContent()) ?? "").includes("set up"), "state badge");
    return { detail: `title «${title}»; wrong code → «${wrong}» inside the dialog; right code closes it and the card shows the new state`, shots: [s1, s2, await shot(page, "C-fresh-dialog-done")] };
  });
  await run(C, "fresh", "Cancel while the secret is being asked for, then open again (the review's order, in a browser): one request, and the key on screen confirms", async () => {
    const r = await slowFirstThenReopen(page);
    must(r.asked === 1, `${r.asked} enrol requests`);
    must(r.outcome === "confirmed", `the displayed key's code was ${r.outcome}`);
    return { detail: "first request slow, Cancel (Esc), open again → 1 POST /ui/outside/enroll; the code from the key on screen was accepted" };
  });
  await ctx.close();
}
// ───────── C, control: the commit before this fix, the same order → the code from the key on screen is refused ─────────
{
  const ctx = await context();
  const body = git("show", `${PRE_FIX}:src/ui/settings-outside.js`);
  await ctx.route("**/ui/js/settings-outside.js*", (r: any) => r.fulfill({ status: 200, contentType: "text/javascript", body }));
  const page = await ctx.newPage(); watch(page, errors);
  await signInHost(page);
  await run(C, "stale", "control — the module before the enrolment fix, same order: the browser shows the key of the SECOND request while the first lands last, so its code is refused", async () => {
    const r = await slowFirstThenReopen(page);
    must(r.asked === 2 && r.outcome === "refused", `asked ${r.asked}, outcome ${r.outcome} (the control should reproduce the race)`);
    return { detail: `${r.asked} POST /ui/outside/enroll; the code from the key on screen was refused (the review's finding, reproduced) — see C-control-before-fix-code-refused`, shots: [`${SMOKE}/evidence-C-control-before-fix-code-refused.png`] };
  });
  await ctx.close();
}
await newDevice?.ctx.close().catch(() => {});

// ───────── Receipt ─────────
const noPageErrors = errors.length === 0;
rows.push({ path: "all", direction: "fresh", step: "no page errors in any tab", ok: noPageErrors, detail: errors.slice(0, 3).join(" | "), shots: [] });
rows.push({ path: "all", direction: "fresh", step: "the authenticator account label is the fixture's fake host name, not this machine's", ok: accountLabel === FIXTURE_HOST && !labelLeak,
  detail: `label «${accountLabel ?? "none seen"}» (the QR code's otpauth URI carries it)`, shots: [] });
// Every screenshot on disk is decoded: one that still reads as a QR code fails the run.
const files = readdirSync(OUT).filter(f => /^evidence-.*\.png$/.test(f)).sort();
const decoded: string[] = [], qrReport: string[] = [];
if (!decodesAsQr) rows.push({ path: "all", direction: "fresh", step: "no screenshot decodes as a QR code", ok: false, detail: "NOT RUN: set QR_DIR=<dir whose node_modules has jsqr and pngjs>; do not publish these screenshots unchecked", shots: [] });
else {
  for (const f of files) { const hit = decodesAsQr(join(OUT, f)); if (hit) decoded.push(f); qrReport.push(`- ${hit ? "**QR DECODED**" : "no QR"}  \`${f}\``); }
  rows.push({ path: "all", direction: "fresh", step: "no screenshot decodes as a QR code (jsQR, both polarities), and the canary does", ok: decoded.length === 0 && canaryDecoded === true && files.length > 0,
    detail: `${files.length} screenshots, ${decoded.length} decoded${decoded.length ? `: ${decoded.join(", ")}` : ""}; canary (the unredacted dialog) ${canaryDecoded ? "decoded" : "did NOT decode — the check cannot see a QR"}`, shots: [] });
}
const pass = rows.every(r => r.ok);
const md = [
  `# Access & security browser evidence`, ``,
  `- Commit: \`${head}\` (${dirty ? "**working tree NOT clean**" : "clean working tree"}); old assets (BASE): \`${BASE}\`; pre-fix controls: \`${PRE_FIX}\``,
  `- One-time local fixture: a web-only fleet in a scratch home on 127.0.0.1; English UI; Chromium. Nothing real: the code, the authenticator key, the code typed into a field and the QR are redacted (in the page, before the shot) in every screenshot, and never printed. The authenticator account label (carried by the QR's otpauth URI) is the fixture's fake host name \`${FIXTURE_HOST}\`.`,
  `- Result: **${rows.filter(r => r.ok).length}/${rows.length} steps pass**${pass ? "" : " — see FAIL rows"}`, ``,
  `| path | direction | step | result | what the browser showed |`, `|---|---|---|---|---|`,
  ...rows.map(r => `| ${r.path} | ${r.direction} | ${r.step.replace(/\|/g, "\\|")} | ${r.ok ? "PASS" : "FAIL"} | ${(r.detail || "").replace(/\|/g, "\\|")}${r.shots.length ? ` — ${r.shots.map(s => `\`${s.split("/")[1]}\``).join(", ")}` : ""} |`),
  ``, `## Requests to the new endpoints (method, path, status — no bodies, no cookies)`, "```", ...[...new Set(net)].sort(), "```", ``,
  `## Redaction, per screenshot (every target present, redacted, and verified before and after the shot; page scan: no key, code, otpauth URI, app-painted QR or hostname)`,
  ...redactionLog.map(l => `- ${l}`), ``,
  `## QR decode check of the screenshots (jsQR, both polarities; canary: ${canaryDecoded === null ? "not run" : canaryDecoded ? "the unredacted dialog decoded, so the check can see a QR" : "DID NOT DECODE"})`,
  ...(qrReport.length ? qrReport : ["- not run (QR_DIR not set)"]), ``,
  `## Old (BASE) files served per direction`,
  `- sign-in page: \`/assets/signin.js\`; stale-shell: ${staleShell.map(p => `\`${urlOf(p)}\``).join(", ")}; Session menu: \`/assets/app-session.js\`; old-page: ${oldPage.map(p => `\`${urlOf(p)}\``).join(", ")}.`, ``,
].join("\n");
writeFileSync(join(OUT, "receipt.md"), md);
console.log("\n" + md.split("\n").slice(0, 6).join("\n"));
await fx.close();
process.exit(pass ? 0 : 1);
