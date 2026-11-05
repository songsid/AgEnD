// Claude history in the View, end to end with a REAL Claude Code (leader cid-claude-history-build, quality rules
// c7e5d374): a real claude binary on the fixture's own isolated tmux socket (never the live server), a scratch HOME and a
// local Messages mock (claude-view-history-mock.py; no account, no network), launched with the production writeConfig +
// buildCommand (scripts/manual/claude-version-audit/gen-cmd.ts) into the fixture instance's own directory, so its
// statusline names the transcript the way a fleet's does. The fixture's FleetManager (never `fleet start`) serves the View.
//
// For each state — idle, busy (a reply streaming), just resumed (`--continue` after the CLI exited) — and on desk (en)
// and phone (zh-TW), dark:
// - the history matches the transcript: the drawn steps are, in order, the transcript's own (prompts, replies, tool
//   calls by Claude's word), and the first step after them is on the live screen (nothing left out between them);
// - delivery is untouched: while the history is open (and a fold opened), a prompt pasted into the pane is answered as
//   usual; the View asked tmux for capture-pane / display-message only (never keys, a paste or copy-mode) and the pane
//   is in no mode.
// Then the stale-tab skew (rule 3): an old View module with this server, this View with a server without the history,
// and the old shell with this View's lazy modules — none breaks, each as specified.
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> CLAUDE_BIN=<claude 2.1.318> [OLD_REF=v2.3.4-beta.8] \
//     npx --prefix <checkout> tsx scripts/manual/smoke/smoke-claude-view-history.mts
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { bootFixture, shotPath } from "../smoke-fixture/index.mts";

const REPO = process.env.REPO!;
const CLAUDE = process.env.CLAUDE_BIN ?? join(homedir(), ".local/share/claude/versions/2.1.318");
const OLD_REF = process.env.OLD_REF ?? "v2.3.4-beta.8";
const HP = Number(process.env.HP ?? 48560), MOCK_PORT = Number(process.env.MOCK_PORT ?? 18378);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const r: Record<string, unknown> = { claude: CLAUDE, oldRef: OLD_REF };
const fail: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => { r[name] = ok ? "PASS" : { FAIL: detail ?? true }; if (!ok) fail.push(name); };

const fx = await bootFixture({ port: HP, instances: 3, classic: false });
const NAME = fx.instances.find((i) => i.backend === "claude-code")!.name;
const { getTmuxSocketName } = await import(REPO + "/src/paths.ts");
const { getTmuxSession } = await import(REPO + "/src/config.ts");
const SOCK: string | null = getTmuxSocketName();
if (!SOCK) throw new Error("no isolated tmux socket: refusing (this would be the live server)");
const SESSION: string = getTmuxSession();
const t = (...a: string[]) => execFileSync("tmux", ["-L", SOCK, ...a], { encoding: "utf8" });
const scratch = mkdtempSync(join(tmpdir(), "vh-e2e-"));
const H = join(scratch, "home"), W = join(scratch, "work");
mkdirSync(join(W, "src"), { recursive: true }); mkdirSync(H, { recursive: true });
writeFileSync(join(W, "src", "forecast.ts"), [
  'const BASE = "https://api.example.test";', "",
  "export async function forecast(city: string): Promise<string> {",
  "  const url = `${BASE}/forecast?q=${city}`;", "  const res = await fetch(url);",
  "  if (!res.ok) throw new Error(`forecast failed: ${res.status}`);",
  "  const body = await res.json() as { temp: number; sky: string };", "  return `${city}  ${body.temp}°C  ${body.sky}`;", "}", ""].join("\n"));
const mock = spawn("python3", ["-I", join(REPO, "scripts/manual/smoke/claude-view-history-mock.py"), String(MOCK_PORT)],
  { cwd: scratch, env: { PATH: "/usr/bin:/bin", VH_WORK: W, VH_LOG: join(scratch, "requests.log") }, stdio: "ignore" });
const cleanup = async () => {
  try { t("kill-server"); } catch { /* none */ }
  try { mock.kill("SIGTERM"); } catch { /* gone */ }
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
  await fx.close();
};

// The fleet's tmux calls from here on (the View's pane reads go through this helper).
const { tmuxExecHelper } = await import(REPO + "/src/tmux-exec-helper.ts");
const tmuxCalls: string[][] = [];
const orig = tmuxExecHelper.exec.bind(tmuxExecHelper);
(tmuxExecHelper as any).exec = (file: string, args: string[], ...rest: unknown[]) => { tmuxCalls.push(args); return (orig as any)(file, args, ...rest); };

const KEY = `sk-ant-api03-${"test".repeat(22)}-testtestAA`;
const instDir: string = fx.fm.getInstanceDir(NAME);
function launch(resume: boolean): void {
  const env = { PATH: process.env.PATH!, HOME: H, CLAUDE_CONFIG_DIR: join(H, ".claude"), ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: `http://127.0.0.1:${MOCK_PORT}` };
  const cmd = execFileSync("npx", ["tsx", join(REPO, "scripts/manual/claude-version-audit/gen-cmd.ts"), instDir, W, CLAUDE, ...(resume ? ["resume"] : [])], { cwd: REPO, encoding: "utf8", env });
  writeFileSync(join(scratch, "cmd.sh"), cmd);
  r[resume ? "resumeCommand" : "launchCommand"] = cmd.replace(KEY, "<key>").replace(/--settings \S+/, "--settings <inst>/claude-settings.json");
  const envs = [`HOME=${H}`, `CLAUDE_CONFIG_DIR=${H}/.claude`, `XDG_CONFIG_HOME=${H}/.config`, `XDG_DATA_HOME=${H}/.local/share`, `XDG_CACHE_HOME=${H}/.cache`,
    `XDG_STATE_HOME=${H}/.local/state`, "DISABLE_AUTOUPDATER=1", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1", "DISABLE_TELEMETRY=1", "DISABLE_ERROR_REPORTING=1",
    "TERM=xterm-256color", `PATH=${dirname(process.execPath)}:/usr/bin:/bin`];
  t("new-session", "-d", "-s", SESSION, "-x", "120", "-y", "40", "-c", W, `env -i ${envs.join(" ")} bash ${join(scratch, "cmd.sh")}; sleep 3600`);
  writeFileSync(join(instDir, "window-id"), t("list-windows", "-t", SESSION, "-F", "#{window_id}").trim().split("\n")[0]!);
}
const cap = (escapes = false) => t("capture-pane", "-p", ...(escapes ? ["-e"] : []), "-t", SESSION);
async function ready(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const s = cap();
    if (/bypass permissions on/.test(s) && /❯/.test(s)) return;
    if (/Enter to continue|Dark mode|trust|Yes, I accept/i.test(s)) t("send-keys", "-t", SESSION, "Enter");
    await sleep(2000);
  }
  throw new Error(`claude never became ready:\n${cap()}`);
}
async function settled(): Promise<void> {
  let last = "", same = 0;
  for (let i = 0; i < 120 && same < 4; i++) { await sleep(500); const s = cap(); same = s === last ? same + 1 : 0; last = s; }
}
async function say(text: string, wait = true): Promise<void> {
  t("set-buffer", "-b", "vh", text); t("paste-buffer", "-p", "-b", "vh", "-t", SESSION);
  await sleep(600); t("send-keys", "-t", SESSION, "Enter");
  if (wait) { await sleep(1500); await settled(); }
}
/**
 * The transcript the instance's statusline names — written by Claude's own statusLine (the production launch's
 * statusline.js), the fleet's source for a Claude without a daemon. Never written here.
 */
function transcriptPath(): string {
  const sl = join(instDir, "statusline.json");
  const p = existsSync(sl) ? JSON.parse(readFileSync(sl, "utf8")).transcript_path : null;
  if (typeof p !== "string" || !existsSync(p)) throw new Error("the statusline names no transcript (yet)");
  return p;
}
async function statuslineNamesTranscript(): Promise<string> {
  for (let i = 0; i < 40; i++) { try { return transcriptPath(); } catch { await sleep(500); } }
  return transcriptPath();
}
// ── The transcript, read independently of AgEnD's parser: prompts, reply texts, tool calls, in order ──
const WORDS: Record<string, string> = { Edit: "Update", MultiEdit: "Update", Grep: "Search", Glob: "Search", WebFetch: "Fetch" };
function transcriptTokens(): string[] {
  const out: string[] = [];
  for (const line of readFileSync(transcriptPath(), "utf8").split("\n")) {
    if (!line.trim()) continue;
    let o: any; try { o = JSON.parse(line); } catch { continue; }
    if (o.isMeta || o.isSidechain) continue;
    const c = o.message?.content;
    if (o.type === "user" && typeof c === "string" && !c.startsWith("<")) out.push(`U:${c.trim().slice(0, 30)}`);
    if (o.type === "user" && Array.isArray(c)) for (const p of c) if (p.type === "text" && !String(p.text).startsWith("<")) out.push(`U:${String(p.text).trim().slice(0, 30)}`);
    if (o.type === "assistant" && Array.isArray(c)) for (const p of c) {
      if (p.type === "text" && p.text.trim()) out.push(`A:${p.text.trim().slice(0, 30)}`);
      if (p.type === "tool_use") out.push(`T:${WORDS[p.name] ?? p.name}`);
    }
  }
  return out;
}
const DOM_TOKENS = `[...document.querySelectorAll(".vh-step")].map((s) => {
  if (s.querySelector(".vh-prompt")) return "U:" + [...s.querySelectorAll(".vh-prompt")].map((l) => l.textContent.slice(2)).join("\\n").trim().slice(0, 30);
  const b = s.querySelector(".vh-b"); if (b) return "T:" + b.textContent;
  const first = s.querySelector(".vh-line"); return "A:" + [...s.querySelectorAll(".vh-line")].map((l) => l.textContent.slice(2)).join("\\n").trim().slice(0, 30);
})`;
const squash = (s: string) => s.replace(/[\s*_\`#>│]/g, "");

async function viewHistory(state: string, device: "desk" | "phone", lang: "en" | "zh-TW") {
  const tag = `${state}-${device}-${lang}`;
  const { ctx, page, csp } = await fx.page({ device, theme: "dark", lang } as any);
  const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
  tmuxCalls.length = 0;
  await page.goto(`${fx.base}/view/${encodeURIComponent(NAME)}`);
  await page.waitForSelector(".v-pre:has-text(\"❯\")", { timeout: 15000 });
  await page.click("button.v-term-earlier");
  await page.waitForSelector(".vh-divider", { timeout: 15000 });
  await page.waitForTimeout(600);
  const dom: string[] = await page.evaluate(DOM_TOKENS);
  const all = transcriptTokens();
  // In order, the transcript's own steps …
  const prefix = dom.every((d, i) => d === all[i]);
  // … and the first one after them (a prompt or a reply) is on the live screen: nothing left out between.
  const screen = squash(cap());
  const next = all.slice(dom.length).find((x) => !x.startsWith("T:"));
  const joined = next === undefined || screen.includes(squash(next.slice(2)).slice(0, 24));
  check(`${tag}-matches-transcript`, dom.length > 0 && prefix && joined, { dom, transcript: all, next });
  r[`${tag}-steps`] = dom.length;
  await page.screenshot({ path: shotPath("claude-view-history", tag, "history") });
  r[`${tag}-csp`] = await csp(); r[`${tag}-errs`] = errs;
  return { ctx, page, errs };
}

try {
  if (!(await (async () => { for (let i = 0; i < 40; i++) { try { execFileSync("python3", ["-I", "-c", `import socket; socket.create_connection(("127.0.0.1", ${MOCK_PORT}), 1)`]); return true; } catch { await sleep(250); } } return false; })())) throw new Error("mock did not start");
  launch(false);
  await ready();
  await say("Hello there.");
  r.transcript = (await statuslineNamesTranscript()).replace(scratch, "<scratch>");
  for (let i = 1; i <= 6; i++) await say(`Question ${i}: what does part ${i} of the forecast module do?`);
  await say("The forecast command crashes when the city has a space in it. VHFIX please.");
  await say("Explain the forecast module in detail. VHLONG");
  r.paneMode0 = t("display-message", "-p", "-t", SESSION, "#{alternate_on} #{history_size}").trim();

  // ── idle: desk en + phone zh-TW; delivery while the history is open ──
  { const { ctx, page } = await viewHistory("idle", "desk", "en");
    // A fold opened (a whole result read), then a prompt delivered while reading.
    const folds = (await page.$$(".vh-more")).length;
    if (folds) { await page.click(".vh-more"); await page.waitForTimeout(1000); }
    r.foldOpened = folds > 0 && (await page.$$(".vh-more")).length === folds - 1;
    const before = transcriptTokens().length;
    await say("Delivery check while the View history is open: reply please.");
    const after = transcriptTokens();
    const answered = after.length > before && after.slice(before).some((x) => x.startsWith("U:Delivery check")) && after.slice(before).some((x) => x.startsWith("A:mock reply"));
    const kinds = [...new Set(tmuxCalls.map((a) => a.find((x) => !x.startsWith("-") && x !== SOCK) ?? ""))];
    const inMode = t("display-message", "-p", "-t", SESSION, "#{pane_in_mode}").trim();
    check("idle-delivery-unchanged", answered && kinds.every((k) => k === "capture-pane" || k === "display-message") && inMode === "0", { answered, kinds, inMode });
    r.viewTmuxCommands = kinds;
    await ctx.close(); }
  { const { ctx } = await viewHistory("idle", "phone", "zh-TW"); await ctx.close(); }
  // An anonymous View reader (web.view_access open, not signed in): everyone who may open the View sees the full
  // history (the user's decision on #3069, hmsg-cd4ae6b0: 「能看檢視的都看完整」).
  { const ctx = await fx.browser.newContext({ viewport: { width: 1366, height: 900 }, deviceScaleFactor: 1, colorScheme: "dark" });
    const page = await ctx.newPage();
    const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
    await page.goto(`${fx.base}/view/${encodeURIComponent(NAME)}`);
    await page.waitForSelector(".v-pre:has-text(\"❯\")", { timeout: 15000 });
    await page.click("button.v-term-earlier");
    await page.waitForSelector(".vh-divider", { timeout: 15000 });
    await page.waitForTimeout(600);
    const dom: string[] = await page.evaluate(DOM_TOKENS);
    const all = transcriptTokens();
    const ok = dom.length > 0 && dom.every((d, i) => d === all[i]);
    await page.screenshot({ path: shotPath("claude-view-history", "anonymous-desk-en", "history") });
    check("anonymous-reader-sees-history", ok && errs.length === 0, { dom, errs });
    await ctx.close(); }

  // ── busy: a reply streaming ──
  await say("Take your time on this one. VHSLOW", false);
  await sleep(4000);
  // Busy: Claude's spinner with its running time ("✶ Tempering… (15s · …") on the pane before and after each read.
  const spinning = () => /…\s*\(\d+s\b/.test(cap());
  const busy: boolean[] = [];
  for (const [device, lang] of [["desk", "en"], ["phone", "zh-TW"]] as const) {
    busy.push(spinning());
    const { ctx } = await viewHistory("busy", device, lang); busy.push(spinning()); await ctx.close();
  }
  check("busy-was-busy", busy.every(Boolean), busy);
  await settled();

  // ── just resumed: the CLI exits, then `--continue` ──
  // The marker a running daemon keeps (daemon.ts: the session id it last saw idle), which makes the production launch
  // resume (`--continue`); this harness runs no daemon, so it writes the same value from Claude's own statusline.
  const sid = JSON.parse(readFileSync(join(instDir, "statusline.json"), "utf8")).session_id;
  writeFileSync(join(instDir, "session-id"), String(sid));
  const before = transcriptPath();
  t("kill-session", "-t", SESSION);
  await sleep(1000);
  launch(true);
  check("resume-launch-continues", / --continue\b/.test(String(r.resumeCommand)), r.resumeCommand);
  await ready();
  await sleep(1500);
  const resumed = await statuslineNamesTranscript();
  r.resumedTranscript = resumed.replace(scratch, "<scratch>");
  r.resumedSameFile = resumed === before;
  { const { ctx } = await viewHistory("resumed", "desk", "en"); await ctx.close(); }
  { const { ctx } = await viewHistory("resumed", "phone", "zh-TW"); await ctx.close(); }

  // ── the stale-tab skew (rule 3) ──
  const old = (path: string): string | null => { try { return execFileSync("git", ["-C", REPO, "show", `${OLD_REF}:src/ui/shared/${path}`], { encoding: "utf8", maxBuffer: 16 << 20 }); } catch { return null; } };
  const NEW_LAZY = new Set(["panel-view.js", "view-history.js", "view-history.css", "view-strings.js"]);
  const skew = async (name: string, route: (page: any) => Promise<void>, expect: (page: any) => Promise<Record<string, unknown>>) => {
    const { ctx, page } = await fx.page({ device: "desk", theme: "dark", lang: "en" } as any);
    const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
    const transcriptReads: string[] = []; page.on("request", (q: any) => { if (q.url().includes("transcript=1")) transcriptReads.push(q.url()); });
    await route(page);
    await page.goto(`${fx.base}/view/${encodeURIComponent(NAME)}`);
    await page.waitForSelector(".v-pre:has-text(\"❯\")", { timeout: 15000 });
    const earlier = await page.$("button.v-term-earlier");
    if (earlier) { await earlier.click(); await page.waitForTimeout(2500); }
    else { await page.mouse.move(400, 300); await page.mouse.wheel(0, -600); await page.waitForTimeout(2500); }
    const got = { ...(await expect(page)), transcriptReads: transcriptReads.length, errs };
    await page.screenshot({ path: shotPath("claude-view-history", `skew-${name}`, "desk") });
    await ctx.close();
    return got;
  };
  const noteOf = `document.querySelector(".v-term-history-note")?.textContent || null`;
  // An old View module (a tab that loaded it before the upgrade) with this server: as it was — the Log link, no history read.
  const s1 = await skew("old-view-module", async (page) => {
    const body = old("panel-view.js");
    await page.route("**/assets/panel-view.js*", (route: any) => route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body }));
  }, async (page) => ({ logBar: !!(await page.$(".v-term-logbar")), vh: !!(await page.$(".vh")) }));
  check("skew-old-view-module", s1.transcriptReads === 0 && !s1.vh && s1.errs.length === 0, s1);
  // This View with a server that has no history (it answers the pane's text): no history, no breakage — as before.
  const s2 = await skew("server-without-history", async (page) => {
    await page.route("**/api/pane/**", (route: any) => (route.request().url().includes("transcript=1")
      ? route.fulfill({ status: 200, contentType: "text/plain; charset=utf-8", body: "the pane\n" }) : route.continue()));
  }, async (page) => ({ note: await page.evaluate(noteOf), logBar: !!(await page.$(".v-term-logbar")), vh: !!(await page.$(".vh")) }));
  check("skew-server-without-history", !s2.vh && s2.logBar && /redraws/.test(String(s2.note)) && s2.errs.length === 0, s2);
  // The old shell (every long-lived /assets file from OLD_REF) with this View's lazy modules: the history works, styled.
  const s3 = await skew("old-shell-new-view", async (page) => {
    await page.route("**/assets/**", (route: any) => {
      const file = new URL(route.request().url()).pathname.replace(/^\/assets\//, "");
      if (NEW_LAZY.has(file)) return route.continue();
      const body = old(file);
      if (body === null) return route.continue();
      return route.fulfill({ status: 200, contentType: file.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8", body });
    });
  }, async (page) => ({
    divider: await page.evaluate(`document.querySelector(".vh-divider")?.textContent || null`),
    dividerFlex: await page.evaluate(`(() => { const d = document.querySelector(".vh-divider"); return d ? getComputedStyle(d).display : null; })()`),
    steps: await page.evaluate(`document.querySelectorAll(".vh-step").length`),
  }));
  check("skew-old-shell-new-view", s3.divider === "History above" && s3.dividerFlex === "flex" && Number(s3.steps) > 0 && s3.errs.length === 0, s3);
  r.skew = { s1, s2, s3 };
} catch (e) {
  fail.push("error"); r.error = String((e as Error).stack ?? e).slice(0, 1500);
} finally {
  writeFileSync(shotPath("claude-view-history", "result", "json").replace(/\.png$/, ".json"), JSON.stringify(r, null, 1));
  console.log(JSON.stringify(r, null, 1));
  console.log(fail.length ? `FAIL: ${fail.join(", ")}` : "ALL PASS");
  await cleanup();
  process.exit(fail.length ? 1 : 0);
}
