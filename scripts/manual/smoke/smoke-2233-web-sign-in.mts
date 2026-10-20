// #2233 from defaults (fleet decision a78ebdc5): a backend is signed in from the dashboard of a fleet with NO chat
// connection at all. A fresh profile signed in through the visible /signin, nothing seeded in the browser.
//
// What is real: FleetManager, its LoginController and WebBackendLogins, the /ui/backend-login routes, the browser
// terminal (its own tmux server, `tmux -L agend-term-*`, its HTTP listener and token gate), and the page.
// What is fake: the CLIs — `codex` and `claude` on PATH are scripts that print what the real ones print (a device URL
// and code; a "Paste code here" prompt) and succeed. No vendor, no tunnel, no account. The availability snapshot is a
// fixed list (no `--version` of anything) and post-login recovery is a no-op (no instance is ever started).
//
//   list     — Settings → Agents → Sign-ins: codex "not signed in" with Sign in;
//   device   — its dialog: confirm, Sign in, the provider's link (a link: its own host) and code, then "signed in";
//   picker   — the chat's /backend card offers "Sign in to codex" on the not-signed-in choice, and it opens the dialog;
//   needs    — Needs you's "Paused: sign-in needed" has Sign in (claude-code): confirm, Sign in, the terminal link and
//              access code; the line on another page says it runs; the terminal page takes the code, the fake claude
//              asks for its sign-in code, gets one, and the dialog says "signed in";
//   refused  — no session: 401; a guest session: 403 (and a guest's page never gets the module).
// No page error (WebKit's own lines only).
//   PW_DIR=… REPO=… OUT=… [PW_ENGINE=webkit] npx --prefix <checkout> tsx scripts/manual/smoke/smoke-2233-web-sign-in.mts
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, freshPage, mounted, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-2233-web-sign-in";
const ENGINE = process.env.PW_ENGINE === "webkit" ? "webkit" : "chromium";
const WEBKIT_OWN = /^(Refused to apply a stylesheet because its hash|Viewport argument key "interactive-widget")|^(EventSource|Fetch API) cannot load .* due to access control checks\.$/;
const other = (errors: string[]) => errors.filter((e) => !(ENGINE === "webkit" && WEBKIT_OWN.test(e.replace(/ @ \S+$/, ""))));

const termSockets = async () => (await import("node:child_process")).spawnSync("sh", ["-c", "ls /tmp/tmux-$(id -u) 2>/dev/null | grep '^agend-term-' || true"], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean);
const socketsBefore = new Set(await termSockets());
const fx = await bootFixture({ port: Number(process.env.HP ?? 48790), classic: false });
const fm = fx.fm;
// The fake CLIs, first on PATH for the login's own tmux server (it inherits this process's environment).
const bin = join(fx.dir, "fake-bin"), done = join(fx.dir, "fake-done");
mkdirSync(bin, { recursive: true }); mkdirSync(done, { recursive: true });
writeFileSync(join(bin, "codex"), `#!/bin/sh
if [ "$1 $2" = "login status" ]; then echo "Not logged in"; exit 1; fi
echo "Follow these steps to sign in with ChatGPT using device code authorization:"
echo "1. Open this link in your browser and sign in to your account"
echo "   https://auth.openai.com/codex/device"
echo "2. Enter this one-time code (expires in 15 minutes)"
echo "   ABCD-12345"
while [ ! -f ${JSON.stringify(join(done, "codex"))} ]; do sleep 0.2; done
echo "Successfully logged in"
`);
writeFileSync(join(bin, "claude"), `#!/bin/sh
if [ "$1 $2" = "auth status" ]; then echo '{"loggedIn": false}'; exit 1; fi
echo "Opening your browser to sign in..."
echo "If it did not open, visit: https://claude.ai/oauth/authorize?code=true&client_id=demo"
printf "Paste code here if prompted > "
read code
echo "Login successful"
`);
chmodSync(join(bin, "codex"), 0o755); chmodSync(join(bin, "claude"), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;
delete process.env.TMUX;                                   // never the caller's tmux: the login's server is its own
fm.isCliInstalled = () => true;
fm.backendAvailabilityRows = () => ["claude-code", "codex", "antigravity"].map((backend) => ({ backend, state: "not_signed_in", path: join(bin, backend), version: "1.0.0", auth: "invalid", minVersion: null, checkedAt: 0 }));
fm.recoverBackendInstances = async () => ({ woken: [], restarted: [], pending: [] });

const NAME = fx.instances.filter((i: any) => i.status === "running" && !i.general && i.backend === "claude-code").map((i: any) => i.name)[0];
// NAME is paused for sign-in, as the daemon records it (its pause marker, reason "auth"); Needs you is derived by the real
// code from the fleet's own instance inputs (the hub is not started in the fixture: its derivation is called directly).
{
  const { writePausedMarker } = await import(process.env.REPO + "/src/pause-marker.ts");
  const { deriveNeedsYou } = await import(process.env.REPO + "/src/needs-you.ts");
  writePausedMarker(fm.getInstanceDir(NAME), Date.now() - 60_000, "auth");
  fm.lifecycle.isPaused = (n: string) => n === NAME;
  fm.needsYouItems = () => deriveNeedsYou({ prompts: [], instances: fm.needsYouInstances().filter((i: any) => i.name === NAME), deliveries: [], ownerOf: () => undefined });
}
const results: any = { engine: ENGINE, cases: {} };
let failed = false;
const verdict = (name: string, ok: boolean, d: any) => { results.cases[name] = { ok, ...d }; if (!ok) failed = true; console.log(`${ok ? "ok  " : "FAIL"} ${ENGINE} ${name}: ${JSON.stringify(d).slice(0, 700)}`); };
const until = async (page: any, fn: (a: any) => boolean, arg: any, ms = 20000) => { try { await page.waitForFunction(fn, arg, { timeout: ms, polling: 100 }); return true; } catch { return false; } };
const dialogText = (page: any) => page.evaluate(`(document.querySelector("dialog.dlg[open]")?.textContent || "").replace(/\\s+/g, " ").trim()`);
const clickInDialog = (page: any, re: RegExp) => page.evaluate(`(() => { const b = [...document.querySelectorAll("dialog.dlg[open] button")].find((x) => ${re}.test(x.textContent.trim())); if (b) b.click(); return !!b; })()`);

for (const c of [{ device: "desk", theme: "light", lang: "en" }, { device: "phone", theme: "dark", lang: "zh-TW" }] as const) {
  const tag = `${c.device}-${c.theme}`;
  const zh = c.lang === "zh-TW";
  const p = await freshPage(fx, c as any, { path: "/settings/agents" });
  const page = p.page;
  await mounted(page, 30000);
  // list
  const listed = await until(page, () => [...document.querySelectorAll(".signin-list .s-row")].some((r) => /codex/.test(r.textContent || "")), null);
  const rows = await page.evaluate(`[...document.querySelectorAll(".signin-list .s-row")].map((r) => r.textContent.replace(/\\s+/g, " ").trim())`);
  await page.locator(".signin-list").scrollIntoViewIfNeeded().catch(() => {});
  await page.screenshot({ path: shotPath(SMOKE, `${ENGINE}-${tag}`, "1-list") });
  verdict(`${tag} list`, listed && rows.some((r: string) => /codex/.test(r) && (zh ? /未登入/.test(r) : /not signed in/.test(r))) && rows.some((r: string) => /antigravity/.test(r) && /agy/.test(r)), { rows });
  // device
  await page.evaluate(`(() => { const r = [...document.querySelectorAll(".signin-list .s-row")].find((x) => /^codex/.test(x.textContent.trim())); r && r.querySelector("button").click(); })()`);
  const asked = await until(page, () => !!document.querySelector("dialog.dlg[open] .btn-primary") && !/Checking|正在確認/.test(document.querySelector("dialog.dlg[open]")?.textContent || ""), null);
  const confirmText = await dialogText(page);
  await clickInDialog(page, zh ? /^登入$/ : /^Sign in$/);
  const coded = await until(page, () => /ABCD-12345/.test(document.querySelector("dialog.dlg[open]")?.textContent || ""), null, 30000);
  const link = await page.evaluate(`[...document.querySelectorAll("dialog.dlg[open] a")].map((a) => [a.getAttribute("href"), a.getAttribute("target"), a.getAttribute("rel")])`);
  await page.screenshot({ path: shotPath(SMOKE, `${ENGINE}-${tag}`, "2-device-code") });
  writeFileSync(join(done, "codex"), "");
  const signedIn = await until(page, () => !!document.querySelector("dialog.dlg[open] .signin-ok"), null, 30000);
  await page.screenshot({ path: shotPath(SMOKE, `${ENGINE}-${tag}`, "3-device-done") });
  verdict(`${tag} device`, asked && coded && signedIn && link.some((l: string[]) => l[0] === "https://auth.openai.com/codex/device" && l[1] === "_blank" && l[2] === "noopener noreferrer"),
    { confirmText: confirmText.slice(0, 200), coded, signedIn, link, done: await dialogText(page) });
  await clickInDialog(page, zh ? /^關閉$/ : /^Close$/);
  try { (await import("node:fs")).rmSync(join(done, "codex")); } catch { /* next case writes it again */ }
  // picker
  await page.goto(`${p.base}/ui/chat/${encodeURIComponent(NAME)}`); await mounted(page, 30000); await page.waitForTimeout(800);
  const box = page.locator(".composer textarea, textarea").first();
  await box.click(); await box.fill("/backend"); await page.keyboard.press("Enter");
  const offered = await until(page, () => [...document.querySelectorAll(".cmd-card button")].some((b) => /Sign in to codex|登入 codex/.test(b.textContent || "")), null);
  const choiceLabels = await page.evaluate(`[...document.querySelectorAll(".cmd-card .cmd-choices button")].map((b) => b.textContent.trim())`);
  await page.screenshot({ path: shotPath(SMOKE, `${ENGINE}-${tag}`, "4-backend-picker") });
  await page.evaluate(`(() => { const b = [...document.querySelectorAll(".cmd-card button")].find((x) => /Sign in to codex|登入 codex/.test(x.textContent)); b && b.click(); })()`);
  const pickerDialog = await until(page, () => /codex/.test(document.querySelector("dialog.dlg[open] .dlg-title")?.textContent || ""), null);
  // The not-signed-in choice says so without "(use /login)": Sign in sits beside it.
  verdict(`${tag} picker`, offered && pickerDialog && choiceLabels.some((l: string) => /^codex — (not signed in|未登入)$/.test(l)) && !choiceLabels.some((l: string) => /\/login/.test(l) && /codex/.test(l)), { offered, pickerDialog, choiceLabels });
  await clickInDialog(page, zh ? /^取消$/ : /^Cancel$/);
  await page.waitForTimeout(300);
  // needs
  await page.goto(`${p.base}/ui/needs`); await mounted(page, 30000);
  const needsButton = await until(page, () => [...document.querySelectorAll(".n-item button")].some((b) => /^(Sign in|登入)$/.test(b.textContent.trim())), null);
  await page.screenshot({ path: shotPath(SMOKE, `${ENGINE}-${tag}`, "5-needs") });
  await page.evaluate(`[...document.querySelectorAll(".n-item button")].find((b) => /^(Sign in|登入)$/.test(b.textContent.trim()))?.click()`);
  await until(page, () => !!document.querySelector("dialog.dlg[open] .btn-primary") && !/Checking|正在確認/.test(document.querySelector("dialog.dlg[open]")?.textContent || ""), null);
  await clickInDialog(page, zh ? /^登入$/ : /^Sign in$/);
  const terminalShown = await until(page, () => !!document.querySelector("dialog.dlg[open] a[target=_blank]") && !!document.querySelector("dialog.dlg[open] .signin-value"), null, 30000);
  const terminal = await page.evaluate(`({ url: [...document.querySelectorAll("dialog.dlg[open] a[target=_blank]")].map((a) => a.getAttribute("href")).find((h) => /\\/t\\//.test(h)), code: document.querySelector("dialog.dlg[open] .signin-value")?.textContent || "" })`);
  await page.screenshot({ path: shotPath(SMOKE, `${ENGINE}-${tag}`, "6-terminal-code") });
  // The line on another page of this browser (the dialog closed: it keeps running).
  await clickInDialog(page, zh ? /^關閉$/ : /^Close$/);
  await page.goto(`${p.base}/settings/agents`); await mounted(page, 30000);
  const line = await until(page, () => /claude-code/.test(document.querySelector(".signin-line")?.textContent || ""), null);
  await until(page, () => !!document.querySelector(".signin-list .s-row"), null, 5000);
  await page.screenshot({ path: shotPath(SMOKE, `${ENGINE}-${tag}`, "7-line") });
  // The terminal: the access code at its gate, then the fake claude's prompt takes a sign-in code.
  const term = await p.ctx.newPage();
  let entered = false, prompted = false;
  if (terminal.url) {
    await term.goto(terminal.url);
    await term.fill("#token", terminal.code); await term.click("#gate-form button[type=submit]");
    entered = await until(term, () => !document.querySelector("#term")?.hidden, null);
    prompted = await until(term, () => !document.querySelector("#code-row")?.hidden, null);
    if (prompted) { await term.fill("#code", "demo-code-123"); await term.click("#code-row button[type=submit]"); }
    await term.screenshot({ path: shotPath(SMOKE, `${ENGINE}-${tag}`, "8-terminal") });
  }
  const lineGone = await until(page, () => !document.querySelector(".signin-line"), null, 30000);
  await page.evaluate(`document.querySelector(".signin-line button")?.click()`);
  await term.close();
  // The starter's dialog, opened again from the list's state: it ended signed in.
  await page.goto(`${p.base}/settings/agents`); await mounted(page, 30000);
  const view = await page.evaluate(`fetch("/ui/backend-login", { cache: "no-store" }).then((r) => r.json())`);
  verdict(`${tag} needs`, needsButton && terminalShown && /^[A-Z0-9]{20}$/.test(terminal.code) && line && entered && prompted && lineGone && view.login?.phase === "ended" && view.login?.ok === true,
    { needsButton, terminalShown, terminalHost: terminal.url ? new URL(terminal.url).host : null, codeShape: terminal.code.length, line, entered, prompted, lineGone, ended: view.login && { phase: view.login.phase, ok: view.login.ok, lines: view.login.lines } });
  verdict(`${tag} errors`, other(p.errors).length === 0, { errors: other(p.errors) });
  await p.ctx.close();
}

// refused: no session, and a guest session (the API; a guest's page never imports the module — app.js loads it only
// when the page is not a guest's, covered by the unit tests).
{
  const { tokenEpoch } = await import(process.env.REPO + "/src/web-session.ts");
  fm.initializeWebSessions();
  const none = await fetch(`${fx.base}/ui/backend-login`, { headers: { origin: fx.base } });
  const guest = fm.webSessions.create({ tier: "guest", surface: "local", label: "smoke guest", tokenEpoch: tokenEpoch(fm.webToken), owner: { adapterId: "demo", userId: "900000000000000999" } });
  const asGuest = await fetch(`${fx.base}/ui/backend-login`, { headers: { origin: fx.base, cookie: `agend_session=${guest.sessionId}` } });
  // A guest is refused by the gate (401 while guest sign-in is off, 403 guest_forbidden when it is on) or the route (403).
  verdict("refused", none.status === 401 && (asGuest.status === 401 || asGuest.status === 403), { none: none.status, guest: asGuest.status });
}
// No login tmux server left running (the terminal's own servers are agend-term-*; never the caller's).
// A socket file may outlive its server; what must not survive is a running server (a login CLI still alive).
const { spawnSync } = await import("node:child_process");
const leftovers = (await termSockets()).filter((s) => !socketsBefore.has(s));
const alive = leftovers.filter((s) => spawnSync("tmux", ["-L", s, "list-sessions"], { encoding: "utf8" }).status === 0);
verdict("cleanup", alive.length === 0, { alive, socketFilesLeft: leftovers.length });
writeFileSync(shotPath(SMOKE, "results", ENGINE).replace(/\.png$/, ".json"), JSON.stringify(results, null, 1));
console.log(`${failed ? "FAIL" : "PASS"} ${ENGINE}`);
await fx.close();
process.exit(failed ? 1 : 0);
