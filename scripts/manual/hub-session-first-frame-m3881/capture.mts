/** Production Hub HTML/assets + owned fixture HTTP. Four frames, one serial Chromium. */
import { createServer } from "node:https";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, loadavg } from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { listenLoopback } from "../smoke-fixture/listen-loopback.mts";

const repo = process.cwd(), out = process.env.OUT!;
if (!out) throw new Error("OUT is required");
if (loadavg()[0] > 8) throw new Error("Defer capture: host load exceeds8");
mkdirSync(out, { recursive: true });
const home = mkdtempSync(join(tmpdir(), "hub-first-frame-")); process.env.AGEND_HOME = home;
const inputs = ["src/ui/shared/app.js", "src/ui/shared/app-shell.js", "src/ui/shared/ui-states.js", "src/ui/shared/app.css", "src/ui/panel-hub.js", "src/ui/app.html", "src/web-api.ts", "scripts/manual/hub-session-first-frame-m3881/capture.mts"];
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const bindings = inputs.map(path => ({ path, sha256: hash(readFileSync(path)) }));
const result: any = { commit: git("rev-parse", "HEAD"), inputs: bindings, cases: [], checks: [], scope: "Actual production Hub fixture HTTPS, held actual signed-out session response; four current frames only; no live Hub, directory, Fleet or vendor operation." };
const check = (name: string, ok: unknown) => { result.checks.push({ name, pass: !!ok }); if (!ok) throw new Error(name); };
const sameSource = () => bindings.every(x => hash(readFileSync(x.path)) === x.sha256);
let browser: any, rig: any, context: any, release: (() => void) | undefined, releaseEntry: (() => void) | undefined, loadStopped = false;
const server = createServer();
const monitor = setInterval(() => { if (loadavg()[0] > 8) { loadStopped = true; void browser?.close(); } }, 500);
try {
  const { s3bRig } = await import(repo + "/tests/helpers/hub-s3b-rig.ts");
  const { provisionHubIdentity } = await import(repo + "/src/hub/tls.ts");
  const port = await listenLoopback(server), origin = `https://127.0.0.1:${port}`;
  await provisionHubIdentity({ home, memberOrigin: origin });
  server.setSecureContext({ key: readFileSync(join(home, "hub/keys/tls-key.pem")), cert: readFileSync(join(home, "hub/keys/tls-cert.pem")) });
  rig = await s3bRig({ webOrigin: origin });
  server.on("request", (req, res) => { if (!rig.http.handle(req, res)) { res.writeHead(404); res.end("not found"); } });
  const pw = createRequire(join(process.env.PW_DIR!, "package.json"))("playwright-core");
  browser = await pw.chromium.launch({ headless: true, executablePath: process.env.CHROME, args: ["--no-sandbox"] });
  for (const c of [{ key: "desk-light-en", width: 1366, height: 900, theme: "light", lang: "en", phone: false }, { key: "phone-dark-zh-TW", width: 390, height: 844, theme: "dark", lang: "zh-TW", phone: true }]) {
    check(c.key + ":source-unchanged", sameSource()); check(c.key + ":load-within-bound", !loadStopped && loadavg()[0] <= 8);
    context = await browser.newContext({ viewport: { width: c.width, height: c.height }, colorScheme: c.theme, locale: c.lang === "en" ? "en-US" : "zh-TW", isMobile: c.phone, hasTouch: c.phone, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
    await context.addInitScript(({ lang, theme }: any) => {
      localStorage.setItem("agend_lang", lang); localStorage.setItem("agend_theme", theme); localStorage.setItem("agend_tour_done", "1");
      const w = window as any; w.__firstFrames = [];
      new MutationObserver(() => {
        const app = document.querySelector("#app"); if (!app) return;
        const signature = [!!app.querySelector(".shell"), !!app.querySelector(".session-loading-page"), !!app.querySelector("#hubLogin")].join(":");
        if (w.__firstFrames.at(-1) !== signature && w.__firstFrames.length < 100) w.__firstFrames.push(signature);
      }).observe(document, { childList: true, subtree: true });
    }, { lang: c.lang, theme: c.theme });
    let observed!: () => void;
    const requested = new Promise<void>(resolve => { observed = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entryObserved!: () => void;
    const entryRequested = new Promise<void>(resolve => { entryObserved = resolve; });
    const entryGate = new Promise<void>(resolve => { releaseEntry = resolve; });
    const requests: string[] = [], failures: string[] = [], foreign: string[] = [], writes: string[] = [];
    await context.route("**/*", async (route: any) => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin !== origin) { foreign.push(url.origin); return route.abort(); }
      if (!["GET", "HEAD"].includes(req.method())) { writes.push(req.method() + " " + url.pathname); return route.abort(); }
      if (url.pathname.startsWith("/hub/v1/")) requests.push(url.pathname);
      if (url.pathname === "/assets/app.js") { entryObserved(); await entryGate; }
      if (url.pathname === "/hub/v1/session") { observed(); await gate; }
      return route.continue();
    });
    const page = await context.newPage(); page.on("pageerror", (e: Error) => failures.push(e.message));
    await page.goto(origin + "/ui/hub", { waitUntil: "commit" }); await entryRequested;
    await page.locator(".session-loading-page").waitFor();
    await page.waitForFunction(() => ["/assets/app.css", "/assets/loading.css"].every(path => Array.from(document.styleSheets).some(s => s.href?.includes(path))));
    const initial = await page.evaluate(() => ({ visible: getComputedStyle(document.querySelector(".session-loading-page .skeleton")!).opacity === "1" && getComputedStyle(document.querySelector(".session-loading-page .skeleton")!).animationName === "none" && document.querySelector(".session-loading-page .sk-line")!.getBoundingClientRect().height > 0, oldBoot: !!document.querySelector(".sk-boot"), sidebar: !!document.querySelector("#sidebar"), rect: Array.from(["x", "y", "width", "height"], key => Math.round((document.querySelector(".session-loading-page")!.getBoundingClientRect() as any)[key])) }));
    check(c.key + ":neutral-before-modules", initial.visible && !initial.oldBoot && !initial.sidebar);
    releaseEntry!(); releaseEntry = undefined; await requested;
    await page.locator(".session-loading-page").waitFor(); await page.evaluate(() => document.fonts.ready);
    const pending = await page.evaluate(() => ({ visible: getComputedStyle(document.querySelector(".session-loading-page .skeleton")!).opacity === "1" && getComputedStyle(document.querySelector(".session-loading-page .skeleton")!).animationName === "none" && document.querySelector(".session-loading-page .sk-line")!.getBoundingClientRect().height > 0, count: document.querySelectorAll(".session-loading-page").length, label: document.querySelector(".session-loading-page")?.getAttribute("aria-label"), sidebar: !!document.querySelector("#sidebar"), text: document.querySelector("#app")?.textContent, oldBoot: !!document.querySelector(".sk-boot"), rect: Array.from(["x", "y", "width", "height"], key => Math.round((document.querySelector(".session-loading-page")!.getBoundingClientRect() as any)[key])), busy: document.querySelector(".session-loading-page")?.getAttribute("aria-busy"), overflow: document.documentElement.scrollWidth > innerWidth }));
    check(c.key + ":pending-neutral", pending.visible && pending.count === 1 && pending.label === (c.lang === "en" ? "Loading…" : "載入中…") && !pending.oldBoot && !pending.sidebar && !pending.text?.includes("Team Hub") && pending.busy === "true" && !pending.overflow);
    check(c.key + ":same-neutral-frame", JSON.stringify(initial.rect) === JSON.stringify(pending.rect));
    check(c.key + ":one-session-read-only", requests.length === 1 && requests[0] === "/hub/v1/session");
    const loadingShot = c.key + "-loading.png"; await page.screenshot({ path: join(out, loadingShot) });
    release!(); release = undefined;
    await page.locator("#hubLogin").waitFor();
    await page.waitForFunction(() => Array.from(document.styleSheets).some(s => s.href?.includes("/assets/hub-signin.css")));
    await page.evaluate(() => document.fonts.ready);
    const settled = await page.evaluate(() => ({ sidebar: !!document.querySelector("#sidebar"), loading: !!document.querySelector(".session-loading-page"), heading: document.querySelector("#hubSignInTitle")?.textContent, frames: (window as any).__firstFrames, overflow: document.documentElement.scrollWidth > innerWidth }));
    check(c.key + ":signin-only", !settled.sidebar && !settled.loading && settled.heading === (c.lang === "en" ? "Sign in to the Hub" : "登入 Hub") && !settled.overflow);
    check(c.key + ":no-shell-in-recorded-commits", settled.frames.every((s: string) => s.startsWith("false:")));
    check(c.key + ":no-live-or-write-or-runtime-error", !foreign.length && !writes.length && !failures.length);
    const signinShot = c.key + "-signin.png"; await page.screenshot({ path: join(out, signinShot) });
    result.cases.push({ ...c, initial, pending, settled, requests, foreign, writes, failures, images: [loadingShot, signinShot].map(path => ({ path, sha256: hash(readFileSync(join(out, path))) })) });
    await context.close(); context = undefined;
  }
  check("final:source-unchanged", sameSource()); check("final:load-within-bound", !loadStopped && loadavg()[0] <= 8);
} catch (error) { result.error = loadStopped ? "Stopped: host load exceeded8" : String(error); process.exitCode = 1; }
finally {
  clearInterval(monitor); releaseEntry?.(); release?.(); await context?.close().catch(() => {}); await browser?.close().catch(() => {});
  server.closeAllConnections(); if (server.listening) await new Promise<void>(resolve => server.close(() => resolve())); await rig?.close(); rmSync(home, { recursive: true, force: true });
  result.cleanedUp = true; writeFileSync(join(out, "report.json"), JSON.stringify(result, null, 2) + "\n");
}
