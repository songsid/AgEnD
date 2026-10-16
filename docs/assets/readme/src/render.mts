/**
 * The README hero image (hero-light.webp, hero-dark.webp): a real render of the web dashboard's chat view, with
 * made-up demo data only, next to an illustrated phone in AgEnD's own style.
 *
 * What it does, and does not do:
 * - A FleetManager on a scratch AGEND_HOME (a temporary folder) serves the dashboard on 127.0.0.1. No fleet is started,
 *   no agent CLI runs, nothing connects to Discord or Telegram, and nothing is read from your own AgEnD home.
 * - Every name, message, number and file in the picture is written below (DEMO).
 * - Chromium draws the dashboard (light and dark), then hero.html composes it with the phone; the result is encoded as
 *   WebP by the browser itself.
 *
 * Run it from the repository root, with playwright-core, a Chromium build, and a color emoji font that fontconfig
 * finds (Noto Color Emoji; without one, every emoji is an empty box):
 *   PW_DIR=<a folder whose node_modules has playwright-core> CHROME=<path to chrome> \
 *     FONTCONFIG_FILE=<a fonts.conf that includes the emoji font> npx tsx docs/assets/readme/src/render.mts
 * Optional: OUT=<folder> (default docs/assets/readme), PORT=<n> (default 47990), QUALITY=<0..1> (default 0.86).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");
const OUT = resolve(process.env.OUT ?? join(REPO, "docs/assets/readme"));
const PORT = Number(process.env.PORT ?? 47990);
const QUALITY = Number(process.env.QUALITY ?? 0.86);
const require = createRequire((process.env.PW_DIR ?? REPO) + "/");
const { chromium } = require("playwright-core");

// ── DEMO: everything the picture shows ────────────────────────────────────────────────────────────────────────────

const AGENTS = [
  { name: "Pixel", emoji: "🎨", tags: ["product"], backend: "claude-code", model: "opus", status: "running", exec: "working", about: "Front end" },
  { name: "Atlas", emoji: "🦉", tags: ["product"], backend: "codex", model: "gpt-5", status: "running", exec: "working", about: "API and data" },
  { name: "Quill", emoji: "🔍", tags: ["product"], backend: "claude-code", model: "sonnet", status: "running", exec: "idle", about: "Code review" },
  { name: "Sage", emoji: "📚", tags: ["support"], backend: "claude-code", model: "sonnet", status: "running", exec: "idle", about: "Docs" },
  { name: "Orbit", emoji: "🚀", tags: ["support"], backend: "codex", model: "gpt-5", status: "running", exec: "working", about: "CI and deploys" },
  { name: "Comet", emoji: "🔭", tags: ["support"], backend: "claude-code", model: "opus", status: "stopped", exec: null, about: "Research" },
] as const;
const CHAT = "Pixel";
const BUTTONS = "b".repeat(32);
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const TABLE = [
  "Lazy-loading the editor and the charts cut the first load by a third:",
  "",
  "| Bundle | Before | After | Change |",
  "|---|---:|---:|---:|",
  "| main.js | 412 KB | 268 KB | −35% |",
  "| editor.js | 188 KB | 121 KB | −36% |",
  "",
  "```ts",
  "const Editor = lazy(() => import(\"./editor\"));",
  "```",
  "",
  "Tests pass, and the full report is attached. Ship it?",
].join("\n");
const HISTORY = [
  { role: "user", text: "Compare the bundle sizes before and after the refactor?", at: 9 },
  { role: "agent", text: TABLE, at: 7, buttons: { id: BUTTONS, labels: ["Ship it", "Hold"], state: "chosen", chosen: 0, by: "you" }, file: { name: "bundle-report.pdf", size: 48_213 } },
  { role: "user", text: "[button] Ship it", at: 1, click: { label: "Ship it", of: BUTTONS } },
  // …and Pixel is working on it now: the chat shows its working bar.
] as const;
// The usage rail, one made-up row per provider in each provider's own shape (src/usage/providers.ts).
const HOUR = 3_600_000, DAY = 24 * HOUR;
const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();
const USAGE = {
  fetchedAt: new Date().toISOString(),
  providers: [
    { id: "claude", name: "Claude", status: "ok", plan: "Max", metrics: [
      { label: "Session", type: "percent", used: 34, resetsAt: inMs(2.3 * HOUR), windowMs: 5 * HOUR },
      { label: "Weekly", type: "percent", used: 52, resetsAt: inMs(3 * DAY), windowMs: 7 * DAY },
    ] },
    { id: "codex", name: "Codex", status: "ok", plan: "Pro 20x", metrics: [
      { label: "Session", type: "percent", used: 18, resetsAt: inMs(3.4 * HOUR), windowMs: 5 * HOUR },
      { label: "Weekly", type: "percent", used: 27, resetsAt: inMs(4 * DAY), windowMs: 7 * DAY },
    ] },
    { id: "antigravity", name: "Antigravity", status: "ok", plan: null, metrics: [
      { label: "Gemini (weekly)", type: "percent", used: 41, resetsAt: inMs(5 * DAY) },
    ] },
    { id: "grok", name: "Grok", status: "ok", plan: "SuperGrok", metrics: [
      { label: "Weekly limit", type: "percent", used: 12, resetsAt: inMs(6 * DAY), windowMs: 7 * DAY },
      { label: "Pay as you go", type: "text", value: "Disabled" },
    ] },
    { id: "kiro", name: "Kiro", status: "ok", plan: "Kiro Pro", metrics: [
      { label: "Credits (monthly)", type: "percent", used: 38, resetsAt: inMs(18 * DAY), note: "380 / 1000 credits" },
    ] },
  ],
};

// ── the dashboard, on a scratch home ─────────────────────────────────────────────────────────────────────────────

const home = mkdtempSync(join(tmpdir(), "agend-readme-hero-"));
const errors: string[] = [];
// What this run acquired, released in `finally` whatever failed (a bad CHROME path, an import, a render): each on its
// own, so one that fails to close never keeps the others — above all the scratch home — from going.
let fm: any = null, browser: any = null, work: string | null = null;
try {
  process.env.AGEND_HOME = home;
  const yaml = [
    `health_port: ${PORT}`,
    "instances:",
    ...AGENTS.flatMap(a => [
      `  ${a.name}:`,
      `    working_directory: ${home}`,
      `    backend: ${a.backend}`,
      `    model: ${a.model}`,
      `    description: ${a.about}`,
      `    tags: [${a.tags.join(", ")}]`,
      `    status_emojis:`,
      `      delivered: "${a.emoji}"`,
    ]),
    "web:",
    `  preview_port: ${PORT + 1}`,
  ].join("\n") + "\n";
  writeFileSync(join(home, "fleet.yaml"), yaml);

  const { FleetManager } = await import(join(REPO, "src/fleet-manager.ts"));
  const { tokenEpoch } = await import(join(REPO, "src/web-session.ts"));
  const { OPERATOR } = await import(join(REPO, "src/web-prefs.ts"));
  const { setUsageFetcherForTests } = await import(join(REPO, "src/usage/usage-api.ts"));
  fm = new FleetManager(home);
  const quiet = () => {};
  fm.logger = { info: quiet, warn: quiet, error: quiet, debug: quiet, trace: quiet, fatal: quiet, child: () => fm.logger };
  fm.notifyFleetError = () => true;
  fm.loadConfig(join(home, "fleet.yaml"));
  fm.lifecycle = { isPaused: () => false, hasWorkLease: () => false, daemons: new Map() };
  const byName = new Map<string, (typeof AGENTS)[number]>(AGENTS.map(a => [a.name, a]));
  fm.getInstanceStatus = (n: string) => byName.get(n)?.status ?? "stopped";
  fm.getInstanceExecutionState = (n: string) => byName.get(n)?.exec ?? null;
  fm.getActiveUsageProviderIds = () => new Set(["claude", "codex", "antigravity", "grok", "kiro"]);
  setUsageFetcherForTests(async () => USAGE as never);

  // The thread: recorded before the page loads (the page reads it from the history).
  for (const m of HISTORY) {
    const base = { instance: CHAT, ts: minutesAgo(m.at), text: m.text };
    if (m.role === "user") { fm.webChatHistory.record({ ...base, sender: "web-user", role: "user", ...("click" in m ? { click: m.click } : {}) }); continue; }
    const attachments = "file" in m ? [{ id: "f".repeat(32), kind: "document", name: m.file.name, size: m.file.size, mime: "application/pdf" }] : undefined;
    fm.webChatHistory.record({ ...base, sender: CHAT, role: "agent", ...("buttons" in m ? { buttons: m.buttons } : {}), ...(attachments ? { attachments } : {}) });
  }

  fm.initializeWebAuthTokens();
  fm.startHealthServer(PORT);
  await new Promise(r => setTimeout(r, 600));
  const signinCode = () => { fm.initializeWebSessions(); return fm.webLoginCodes.issue({ tier: "admin", epoch: tokenEpoch(fm.webToken) }).display; };

  // ── Chromium: the dashboard, then the composite ──────────────────────────────────────────────────────────────────

  browser = await chromium.launch({ executablePath: process.env.CHROME, args: ["--no-sandbox"] });
  const base = `http://127.0.0.1:${PORT}`;
  const DASH = { width: Number(process.env.DASH_W ?? 1240), height: Number(process.env.DASH_H ?? 1000) };
  mkdirSync(OUT, { recursive: true });
  work = mkdtempSync(join(tmpdir(), "agend-readme-hero-out-"));

  async function dashboard(theme: "light" | "dark"): Promise<string> {
    // The host's synced theme decides what the page paints (#1665): set it for this render.
    fm.webPrefs.write(OPERATOR, new Map([["theme", theme]]));
    const ctx = await browser.newContext({ viewport: DASH, deviceScaleFactor: 2, colorScheme: theme, locale: "en-US" });
    await ctx.addInitScript({ content: `try {
      localStorage.setItem("agend_tour_done", "1"); localStorage.setItem("agend_firstrun_dismissed", "1");
      localStorage.setItem("agend_usage_rail", "1"); localStorage.setItem("agend_theme", ${JSON.stringify(theme)});
      localStorage.setItem("agend_text_size", ${JSON.stringify(process.env.TEXT_SIZE || "m")});
    } catch {}` });
    const page = await ctx.newPage();
    page.on("pageerror", (e: Error) => errors.push(`${theme}: ${String(e).slice(0, 200)}`));
    await page.goto(`${base}/signin`); await page.waitForSelector("#code");
    await page.fill("#code", signinCode()); await page.click("#go"); await page.waitForURL(`${base}/ui`);
    await page.goto(`${base}/ui/chat/${CHAT}`);
    await page.waitForFunction((n: number) => document.querySelectorAll(".p-chat .msg").length >= n, HISTORY.length, { timeout: 20_000 });
    await page.waitForTimeout(1500);                                      // avatars, the usage rail, fonts
    // MEASURE=1: where things are (viewport CSS px), for laying out hero.html. A string: tsx would rename helpers.
    if (process.env.MEASURE) console.log(theme, await page.evaluate(`JSON.stringify((() => {
      const r = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.right), Math.round(b.bottom)]; };
      const rail = document.querySelector(".u-rail"), body = rail && rail.querySelector(".u-rail-body");
      const kids = body ? [...body.querySelectorAll("*")].filter((e) => e.getBoundingClientRect().height > 0) : [];
      const bottom = kids.reduce((m, e) => Math.max(m, e.getBoundingClientRect().bottom), 0);
      return { rail: r(rail), railContentBottom: Math.round(bottom), firstMsg: r(document.querySelector(".p-chat .msg")), table: r(document.querySelector(".p-chat table")), composer: r(document.querySelector("#msgIn")) };
    })())`));
    const file = join(work!, `dash-${theme}.png`);
    await page.screenshot({ path: file });
    await ctx.close();
    return file;
  }

  async function composite(theme: "light" | "dark", shot: string): Promise<void> {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2, colorScheme: theme });
    const page = await ctx.newPage();
    page.on("pageerror", (e: Error) => errors.push(`hero ${theme}: ${String(e).slice(0, 200)}`));
    const url = pathToFileURL(join(HERE, "hero.html"));
    url.searchParams.set("theme", theme);
    url.searchParams.set("shot", pathToFileURL(shot).href);
    await page.goto(url.href);
    await page.waitForFunction(() => (window as any).heroReady === true, null, { timeout: 20_000 });
    if (process.env.MEASURE) console.log(`hero ${theme}`, await page.evaluate(`JSON.stringify([".screen", ".msgs", ".typing", ".chip", ".b.bot"].map((s) => { const b = document.querySelector(s).getBoundingClientRect(); return [s, Math.round(b.top), Math.round(b.bottom)]; }))`));
    const png = await page.screenshot({ type: "png" });
    // WebP, encoded by the browser: no image tool needed beyond Chromium.
    const b64: string = await page.evaluate(async ({ data, q }: { data: string; q: number }) => {
      const img = new Image(); img.src = `data:image/png;base64,${data}`; await img.decode();
      const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext("2d")!.drawImage(img, 0, 0);
      return c.toDataURL("image/webp", q).split(",")[1]!;
    }, { data: Buffer.from(png).toString("base64"), q: QUALITY });
    const out = join(OUT, `hero-${theme}.webp`);
    writeFileSync(out, Buffer.from(b64, "base64"));
    console.log(`${out}: ${Math.round(readFileSync(out).length / 1024)} KB`);
    await ctx.close();
  }

  for (const theme of ["light", "dark"] as const) await composite(theme, await dashboard(theme));
} finally {
  try { await browser?.close(); } catch { /* already gone */ }
  try { fm?.healthServer?.close?.(); } catch { /* already closed */ }
  rmSync(home, { recursive: true, force: true });
  if (work) rmSync(work, { recursive: true, force: true });
}
if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
process.exit(0);
