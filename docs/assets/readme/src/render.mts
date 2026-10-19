/**
 * The docs' pictures of the web dashboard, rendered by this repository's own code with made-up demo data only:
 * - the README hero (docs/assets/readme/hero-{light,dark}.webp): the chat view beside an illustrated phone (hero.html);
 * - the "What's new in 2.2" shots (docs/assets/whats-new-2.2/<scene>-{light,dark}.webp), each framed by frame.html:
 *   chat, preview, needs, usage, org, and (2.2.5) appearance — an agent's own theme, identity card, header widget and
 *   ambient petals —, usage-page (Fleet → Usage) and guests (Settings → Web → Guests). No Canvas Worker effect is shown.
 *
 * What it does, and does not do:
 * - A FleetManager on a scratch AGEND_HOME (a temporary folder) serves the dashboard on 127.0.0.1. No fleet is started,
 *   no agent CLI runs, nothing connects to Discord or Telegram, and nothing is read from your own AgEnD home.
 * - Every name, message, number and file in the pictures is written below (DEMO). Each scene sets what it shows (the
 *   thread, Needs you, the usage rows, who is working) just before it is drawn. The usage report and the guest list are
 *   built from made-up numbers and accounts here (no transcript is read, no guest ever signs in); the appearance scene's
 *   pictures are drawn by Chromium like the chart.
 * - The fleet has a General (the org chart's top); the committed README hero was rendered before it was added.
 * - Chromium draws each page in light and dark at 2×; the result is encoded as WebP by the browser itself.
 *
 * Run it from the repository root, with playwright-core, a Chromium build, and a color emoji font that fontconfig
 * finds (Noto Color Emoji; without one, every emoji is an empty box):
 *   PW_DIR=<a folder whose node_modules has playwright-core> CHROME=<path to chrome> \
 *     FONTCONFIG_FILE=<a fonts.conf that includes the emoji font> npx tsx docs/assets/readme/src/render.mts
 * No colour emoji font on the host? Run it in the Playwright image (it has Noto Color Emoji) with the host's Node:
 *   docker run --rm --network host --user $(id -u):$(id -g) -e HOME=/tmp -e PW_DIR=/pw -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
 *     -v $PWD:$PWD -v <PW_DIR>:/pw:ro -v <node dir>:/node:ro -w $PWD mcr.microsoft.com/playwright:v1.64.1-noble \
 *     /node/bin/node node_modules/tsx/dist/cli.mjs docs/assets/readme/src/render.mts
 * Optional: SCENES=hero,chat,… (default: all), OUT=<folder> (default: docs/assets), PORT=<n> (default 47990),
 * QUALITY=<0..1> (default 0.86), MEASURE=1 (print where things are, for laying out hero.html).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");
const OUT = resolve(process.env.OUT ?? join(REPO, "docs/assets"));
const PORT = Number(process.env.PORT ?? 47990);
const QUALITY = Number(process.env.QUALITY ?? 0.86);
const ONLY = new Set((process.env.SCENES ?? "").split(",").map(s => s.trim()).filter(Boolean));
const require = createRequire((process.env.PW_DIR ?? REPO) + "/");
const { chromium } = require("playwright-core");

// ── DEMO: everything the pictures show ───────────────────────────────────────────────────────────────────────────

const AGENTS = [
  { name: "Pixel", emoji: "🎨", tags: ["product"], backend: "claude-code", model: "opus", status: "running", exec: "working", about: "Front end" },
  { name: "Atlas", emoji: "🦉", tags: ["product"], backend: "codex", model: "gpt-5", status: "running", exec: "working", about: "API and data" },
  { name: "Quill", emoji: "🔍", tags: ["product"], backend: "claude-code", model: "sonnet", status: "running", exec: "idle", about: "Code review" },
  { name: "Sage", emoji: "📚", tags: ["support"], backend: "claude-code", model: "sonnet", status: "running", exec: "idle", about: "Docs" },
  { name: "Orbit", emoji: "🚀", tags: ["support"], backend: "codex", model: "gpt-5", status: "running", exec: "working", about: "CI and deploys" },
  { name: "Comet", emoji: "🔭", tags: ["support"], backend: "claude-code", model: "opus", status: "stopped", exec: null, about: "Research" },
] as const;
type Exec = "working" | "idle" | "stuck" | null;
/** The org chart's teams (fleet.yaml `teams:`), the same as the sidebar's groups. The hero does not change with these. */
const TEAMS = {
  product: { description: "Plan, build and review", members: ["Pixel", "Atlas", "Quill"] },
  support: { description: "Docs, releases and research", members: ["Sage", "Orbit", "Comet"] },
};
const HOUR = 3_600_000, DAY = 24 * HOUR;
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();

// The hero's thread (Pixel).
const BUTTONS = "b".repeat(32);
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
type Msg = { role: "user" | "agent"; text: string; at: number; buttons?: unknown; click?: unknown; file?: { name: string; size: number }; image?: string; page?: string };
/** The page Quill sends: it follows the viewer's light or dark mode, as a page made for a dark dashboard would. */
const CHECKLIST = `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><style>
:root{--fg:#1d2330;--muted:#5d6472;--line:#e3e7ef;--card:#ffffff;--bg:#ffffff;--ok:#1a7f37;--acc:#0a62c2}
@media (prefers-color-scheme: dark){:root{--fg:#e8ebf1;--muted:#9aa3b2;--line:#343a46;--card:#232831;--bg:#1b1e25;--ok:#56d364;--acc:#7ab7ff}}
body{font:15px/1.5 system-ui,sans-serif;margin:24px;color:var(--fg);background:var(--bg)}
h1{font-size:20px;margin:0 0 4px}p{color:var(--muted);margin:0 0 16px}
label{display:flex;gap:10px;align-items:center;padding:10px 12px;border:1px solid var(--line);background:var(--card);border-radius:10px;margin:8px 0}
input{width:18px;height:18px;accent-color:var(--acc)}.done{color:var(--ok);font-weight:600}
</style></head><body>
<h1>Release 2.2 checklist</h1><p>Tick each step as it is done.</p>
<label><input type="checkbox" checked> Changelog assembled</label>
<label><input type="checkbox" checked> Rehearsal passed on Linux and macOS</label>
<label><input type="checkbox"> Tag and publish</label>
<label><input type="checkbox"> Announce in General</label>
<p class="done">2 of 4 done</p>
</body></html>`;
const HISTORY: Record<string, Msg[]> = {
  Pixel: [
    { role: "user", text: "Compare the bundle sizes before and after the refactor?", at: 9 },
    { role: "agent", text: TABLE, at: 7, buttons: { id: BUTTONS, labels: ["Ship it", "Hold"], state: "chosen", chosen: 0, by: "you" }, file: { name: "bundle-report.pdf", size: 48_213 } },
    { role: "user", text: "[button] Ship it", at: 1, click: { label: "Ship it", of: BUTTONS } },
    // …and Pixel is working on it now: the chat shows its working bar.
  ],
  // The chat shot (Atlas): a table, SQL, reply buttons, the click, and a picture the agent sent.
  Atlas: [
    { role: "user", text: "Why did p95 latency jump this morning?", at: 26 },
    { role: "agent", at: 24, text: [
      "The new search endpoint scans the whole table:",
      "",
      "| Endpoint | p50 | p95 |",
      "|---|---:|---:|",
      "| /search | 38 ms | 910 ms |",
      "| /items | 12 ms | 41 ms |",
      "",
      "```sql",
      "CREATE INDEX idx_items_title ON items (title);",
      "```",
      "",
      "Apply the index on staging?",
    ].join("\n"), buttons: { id: "a".repeat(32), labels: ["Apply on staging", "Not now"], state: "chosen", chosen: 0, by: "you" } },
    { role: "user", text: "[button] Apply on staging", at: 20, click: { label: "Apply on staging", of: "a".repeat(32) } },
    { role: "agent", at: 3, text: "Done. p95 on /search is back to **44 ms**:", image: "latency.png" },
  ],
  // The appearance shot (Sage): its own theme, card, header widget and ambient petals around an ordinary exchange.
  Sage: [
    { role: "user", text: "Is the upgrade page ready for the release?", at: 14 },
    { role: "agent", at: 12, text: [
      "Almost. Three of the four sections are reviewed:",
      "",
      "- **Upgrade in one step**: done",
      "- **Make the dashboard yours**: done",
      "- **Guests**: done",
      "- **Usage**: waiting for the new screenshots",
      "",
      "I'll post the last one as soon as the pictures land.",
    ].join("\n") },
    { role: "user", text: "Great, thanks!", at: 2 },
  ],
  // The preview shot (Quill): a page the agent made, sent as a file and run in the side panel.
  Quill: [
    { role: "user", text: "Draft a one-page release checklist I can share.", at: 12 },
    { role: "agent", at: 10, text: "Here it is, as a page. Open it beside the chat to tick the boxes:", page: "release-checklist.html" },
  ],
};

// The hero's usage rail: one made-up row per provider in each provider's own shape (src/usage/providers.ts).
const USAGE_ALL = [
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
];
// The credential-profiles shot: two Claude accounts, one row each (ids claude:<profile>), and Codex.
const USAGE_PROFILES = [
  { id: "claude:work", name: "Claude (work)", status: "ok", plan: "Max", metrics: [
    { label: "Session", type: "percent", used: 42, resetsAt: inMs(2 * HOUR), windowMs: 5 * HOUR },
    { label: "Weekly", type: "percent", used: 67, resetsAt: inMs(3 * DAY), windowMs: 7 * DAY },
  ] },
  { id: "claude:personal", name: "Claude (personal)", status: "ok", plan: "Pro", metrics: [
    { label: "Session", type: "percent", used: 8, resetsAt: inMs(4.5 * HOUR), windowMs: 5 * HOUR },
    { label: "Weekly", type: "percent", used: 21, resetsAt: inMs(5 * DAY), windowMs: 7 * DAY },
  ] },
  USAGE_ALL[1]!,
];
// The Needs-you shot: one of each kind, grouped by instance (src/needs-you.ts WebNeedsItem).
const NEEDS = () => {
  const now = Date.now();
  return [
    { id: "awaiting:Pixel:-:1", type: "awaiting_input", instance: "Pixel", reason: "permission", detail: "Bash: npm publish --tag next", since: now - 3 * 60_000 },
    { id: "delivery:d1", type: "delivery", instance: "Atlas", reason: "delivery_failed", detail: "Pixel → Atlas · task", since: now - 5 * 60_000, deliveryId: "d1" },
    { id: `prompt:${"c".repeat(32)}`, type: "prompt", instance: "Orbit", reason: "hang", detail: "Orbit has not answered for 10 minutes.", since: now - 10 * 60_000,
      nonce: "c".repeat(32), actions: [{ id: "restart", label: "Restart" }, { id: "wait", label: "Keep waiting" }] },
    { id: "auth:Sage:1", type: "instance", instance: "Sage", reason: "auth_paused", detail: "", since: now - 40 * 60_000 },
    { id: "crashed:Comet:1", type: "instance", instance: "Comet", reason: "crashed", detail: "", since: now - 12 * 60_000 },
  ];
};

// Fleet → Usage: 30 days of made-up daily rows per agent, in the rollup's own shape (usage-rollup.ts DayRow), turned
// into the page's report by the product's buildUsageReport. Totals: [requests, uncached, read, write5m, write1h, write, output].
const USAGE_MODELS: Record<string, { model: string; profile: string; scale: number; until?: number }> = {
  Pixel: { model: "claude-opus-5-5", profile: "default", scale: 1.0 },
  Atlas: { model: "gpt-6.1-sol", profile: "unrecorded", scale: 0.8 },
  Quill: { model: "claude-sonnet-5-5", profile: "default", scale: 0.7 },
  Sage: { model: "claude-sonnet-5-5", profile: "default", scale: 0.45 },
  Orbit: { model: "gpt-6.1-sol", profile: "unrecorded", scale: 0.55 },
  Comet: { model: "claude-opus-5-5", profile: "default", scale: 0.35, until: 4 },   // stopped four days ago
};
const USAGE_REPORT_INPUT = (zone: string) => {
  const now = Date.now();
  const day = (k: number) => new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now - k * DAY));
  const teamOf = (n: string) => Object.entries(TEAMS).find(([, t]) => (t.members as readonly string[]).includes(n))?.[0] ?? null;
  const instances = Object.entries(USAGE_MODELS).map(([name, u], i) => {
    const codex = u.model.startsWith("gpt-");
    const rows = [];
    for (let k = 29; k >= 0; k--) {
      if (u.until !== undefined && k < u.until) continue;
      const weekend = [0, 6].includes(new Date(now - k * DAY).getDay()) ? 0.35 : 1;
      const f = u.scale * weekend * (0.55 + 0.45 * Math.sin(i * 1.7 + k * 0.9) ** 2);
      const t = (n: number) => Math.round(n * f);
      rows.push({ date: day(k), zone, be: codex ? "codex" : "claude-code", pf: u.profile,
        m: { [`${u.model}|0`]: codex ? [t(90), t(320_000), t(6_400_000), 0, 0, 0, t(210_000)] : [t(130), t(42_000), t(18_000_000), t(900_000), t(240_000), 0, t(560_000)] } });
    }
    return { name, backend: codex ? "codex" : "claude-code", team: teamOf(name), status: "ok" as const,
      days: { v: 1 as const, checkpoint: Math.floor(now / HOUR) * HOUR, rows, coverage: [[now - 40 * DAY, now]] as Array<[number, number]> } };
  });
  const messages = Object.entries(USAGE_MODELS).flatMap(([instance, u], i) => Array.from({ length: 30 }, (_, k) => k)
    .filter(k => u.until === undefined || k >= u.until).map(k => ({ instance, hour: Math.floor((now - k * DAY) / HOUR) * HOUR, count: 3 + ((i * 7 + k * 3) % 11) })));
  return { now, zone, instances, messages, scanning: { active: false, caughtUp: true, pendingBytes: 0, pendingFiles: 0 } };
};
// Settings → Web → Guests: three made-up accounts on an open Discord server (ids are not anyone's).
const GUEST_OVERVIEW = () => {
  const now = Date.now();
  return {
    enabled: true, chat: true, instances: ["Atlas", "Comet", "General", "Orbit", "Pixel", "Quill", "Sage"],
    connections: [{ id: "discord", type: "discord", mode: "open", named: ["Sage", "Quill"] }],
    guests: [
      { adapterId: "discord", userId: "900000000000000101", name: "Mina Park", platform: "discord", scope: ["Quill", "Sage"], reach: ["Quill", "Sage"], sessions: 1, lastSeen: now - 12 * 60_000, devices: 1, narrow: null },
      { adapterId: "discord", userId: "900000000000000102", name: "Ana Silva", platform: "discord", scope: ["Quill", "Sage"], reach: ["Quill", "Sage"], sessions: 2, lastSeen: now - 3 * HOUR, devices: 2, narrow: null },
      { adapterId: "discord", userId: "900000000000000103", name: "Leo", platform: "discord", scope: ["Sage"], reach: ["Quill", "Sage"], sessions: 0, lastSeen: now - 2 * DAY, devices: 1, narrow: ["Sage"] },
    ],
  };
};

type Theme = "light" | "dark";
interface Scene {
  name: string;
  /** Where it goes, without -<theme>.webp. */
  out: string;
  path: string;
  viewport: { width: number; height: number };
  rail?: boolean;
  usage?: unknown[];
  needs?: boolean;
  exec?: Partial<Record<string, Exec>>;
  /** After the page is up: clicks, files, waits. */
  prepare?: (page: any) => Promise<void>;
  /** The part of the page to keep (viewport CSS px), or the whole viewport. */
  clip?: (page: any) => Promise<{ x: number; y: number; width: number; height: number } | null>;
  /** hero: composed with the phone (hero.html); else framed (frame.html). */
  hero?: true;
  /** Before the page loads, per theme (e.g. a picture drawn for that theme). */
  before?: (theme: Theme) => Promise<void>;
}
/** What scenes call that is set up only once the fleet and Chromium are (below). */
const hooks: { drawChart?: (theme: Theme) => Promise<void> } = {};
/**
 * The box around every element the selectors match (their union, plus `pad` below and `side` left and right, never
 * past `within`'s own box), in viewport CSS px — what a scene keeps.
 */
const clipTo = (selectors: string[], pad = 0, side = 0, within = "body") => async (page: any) => page.evaluate(`(() => {
  const lim = document.querySelector(${JSON.stringify(within)}).getBoundingClientRect();
  const rs = ${JSON.stringify(selectors)}.flatMap((s) => [...document.querySelectorAll(s)]).map((e) => e.getBoundingClientRect()).filter((r) => r.width && r.height);
  if (!rs.length) return null;
  const x = Math.max(lim.left, 0, Math.min(...rs.map((r) => r.left)) - ${side}), y = Math.min(...rs.map((r) => r.top));
  const w = Math.min(lim.right, innerWidth, Math.max(...rs.map((r) => r.right)) + ${side}) - x, h = Math.min(innerHeight, Math.max(...rs.map((r) => r.bottom)) + ${pad}) - y;
  return { x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) };
})()`);
/** A chat panel without the line under the composer about this browser's authority (the demo session has no account). */
const chatClip = (extra: string[] = []) => async (page: any) => page.evaluate(`(() => {
  const rs = [".p-chat", ...${JSON.stringify(extra)}].map((s) => document.querySelector(s)).filter(Boolean).map((e) => e.getBoundingClientRect());
  const chip = document.querySelector(".p-chat .webauth-chip");
  const x = Math.min(...rs.map((r) => r.left)), y = Math.min(...rs.map((r) => r.top)), right = Math.max(...rs.map((r) => r.right));
  const bottom = chip ? chip.getBoundingClientRect().top - 6 : Math.max(...rs.map((r) => r.bottom));
  return { x: Math.round(x), y: Math.round(y), width: Math.round(right - x), height: Math.round(bottom - y) };
})()`);
const SCENES: Scene[] = [
  { name: "hero", out: "readme/hero", hero: true, path: "/ui/chat/Pixel", viewport: { width: Number(process.env.DASH_W ?? 1240), height: Number(process.env.DASH_H ?? 1000) },
    rail: true, usage: USAGE_ALL },
  { name: "chat", out: "whats-new-2.2/chat", path: "/ui/chat/Atlas", viewport: { width: 1060, height: 1090 }, exec: { Atlas: "idle" },
    before: async (theme) => { await hooks.drawChart!(theme); }, clip: chatClip(),
    prepare: async (page) => {
      // Two files waiting above the composer (nothing is uploaded until Send).
      await page.setInputFiles(".composer input[type=file]", [
        { name: "trace.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ spans: 1243, slowest: "/search" }, null, 2)) },
        { name: "staging-screenshot.png", mimeType: "image/png", buffer: readFileSync(join(home, "demo", "latency-light.png")) },
      ]);
      await page.waitForTimeout(500);
    } },
  { name: "preview", out: "whats-new-2.2/preview", path: "/ui/chat/Quill", viewport: { width: 1180, height: 700 }, clip: clipTo([".p-chat", "aside.pv-panel"]),
    prepare: async (page) => {
      await page.click(".html-card .pv-open");
      await page.waitForSelector("aside.pv-panel", { timeout: 15_000 });
      // The once-per-sign-in note about previews: acknowledged, as a person reading it would.
      for (const sel of [".pv-panel .pv-ack", ".html-card .pv-ack"]) {
        const ack = await page.waitForSelector(sel, { timeout: 5_000 }).catch(() => null);
        if (ack) await ack.click();
      }
      await page.waitForFunction(() => !document.querySelector(".pv-banner"), null, { timeout: 5_000 }).catch(() => {});
      await page.waitForTimeout(1200);
      // The line under the composer about this browser's authority: the demo session has no account, so it would read
      // as an error. Cropping it would cut the preview panel, so it is hidden instead (its box is kept; CSSOM, as the
      // dashboard's CSP allows no style tag).
      await page.evaluate(() => { for (const e of document.querySelectorAll<HTMLElement>(".p-chat .webauth-chip")) e.style.visibility = "hidden"; });
    } },
  { name: "needs", out: "whats-new-2.2/needs", path: "/ui/needs", viewport: { width: 1060, height: 980 }, needs: true, clip: clipTo([".p-needs .panel-title", ".p-needs .n-group"], 16, 40, ".p-needs"),
    prepare: async (page) => { await page.waitForSelector(".p-needs", { timeout: 15_000 }); await page.waitForTimeout(800); } },
  { name: "usage", out: "whats-new-2.2/usage", path: "/ui/chat/Pixel", viewport: { width: 1240, height: 760 }, rail: true, usage: USAGE_PROFILES,
    clip: async (page) => page.evaluate(`(() => {
      const rail = document.querySelector("aside.u-rail"); if (!rail) return null;
      const r = rail.getBoundingClientRect();
      const kids = [...rail.querySelectorAll("*")].filter((e) => e.getBoundingClientRect().height > 0);
      const bottom = Math.min(r.bottom, kids.reduce((m, e) => Math.max(m, e.getBoundingClientRect().bottom), r.top) + 12);
      return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(bottom - r.top) };
    })()`) },
  { name: "org", out: "whats-new-2.2/org", path: "/ui/fleet/org", viewport: { width: 1100, height: 760 }, clip: clipTo([".p-fleet"]),
    prepare: async (page) => { await page.waitForSelector(".p-fleet", { timeout: 15_000 }); await page.waitForTimeout(800); } },
  // 2.2.5: an agent's own look (theme, identity card, header widget, ambient petals).
  { name: "appearance", out: "whats-new-2.2/appearance", path: "/ui/chat/Sage", viewport: { width: 1060, height: 1120 }, exec: { Sage: "idle" }, clip: chatClip(),
    prepare: async (page) => {
      await page.click(".chat-card-toggle");                                         // the card, open
      await page.waitForSelector(".chat-card.open img", { timeout: 10_000 });
      await page.waitForTimeout(4000);                                               // the petals spread down the chat
    } },
  { name: "usage-page", out: "whats-new-2.2/usage-page", path: "/ui/fleet/usage", viewport: { width: 1180, height: 2000 },
    // The page down to the end of the daily trend.
    clip: async (page) => page.evaluate(`(() => {
      const p = document.querySelector(".p-fleet").getBoundingClientRect(), t = document.querySelector(".us-heat") ?? document.querySelector(".us-trend");
      const bottom = t ? t.getBoundingClientRect().bottom + 16 : p.bottom;
      return { x: Math.round(p.left), y: Math.round(p.top), width: Math.round(p.width), height: Math.round(Math.min(bottom, p.bottom) - p.top) };
    })()`),
    prepare: async (page) => {
      await page.waitForSelector(".us-row", { timeout: 15_000 });
      await page.click('.us-bar-top button:has-text("All")');                         // 30 days: the trend and the heatmap
      await page.waitForSelector(".us-heat", { timeout: 15_000 });
      await page.waitForTimeout(1200);
    } },
  { name: "guests", out: "whats-new-2.2/guests", path: "/settings/web", viewport: { width: 1000, height: 1100 }, clip: clipTo([".s-guests"], 0, 0),
    prepare: async (page) => {
      await page.waitForSelector(".s-guests .guest-row", { timeout: 15_000 });
      await page.evaluate(() => document.querySelector(".s-guests")!.scrollIntoView({ block: "start" }));
      await page.waitForTimeout(600);
    } },
];

// ── the dashboard, on a scratch home ─────────────────────────────────────────────────────────────────────────────

const home = mkdtempSync(join(tmpdir(), "agend-readme-hero-"));
process.env.AGEND_HOME = home;
const errors: string[] = [];
// What this run acquired, released in `finally` whatever failed (a bad CHROME path, an import, a render): each on its
// own, so one that fails to close never keeps the others — above all the scratch home — from going.
let fm: any = null, browser: any = null, work: string | null = null;
try {
  const yaml = [
    `health_port: ${PORT}`,
    "instances:",
    // General: the org chart's top. Not in AGENTS (the hero's six agents).
    "  General:", `    working_directory: ${home}`, "    backend: claude-code", "    model: opus", "    general_topic: true", "    description: Runs the fleet",
    "    status_emojis:", "      delivered: \"🧭\"",
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
    "teams:",
    ...Object.entries(TEAMS).flatMap(([n, t]) => [`  ${n}:`, `    description: ${t.description}`, `    members: [${t.members.join(", ")}]`]),
    "web:",
    `  preview_port: ${PORT + 1}`,
    // The guests scene: guest sign-in on, and the agents an open Discord server's guests may reach.
    "  guests:", "    enabled: true", "    chat: true", "    open_instances:", "      discord: [Sage, Quill]", "    narrow:", "      \"discord:900000000000000103\": [Sage]",
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
  let execOverride: Partial<Record<string, Exec>> = {};
  let needsOn = false;
  fm.getInstanceStatus = (n: string) => (n === "General" ? "running" : byName.get(n)?.status ?? "stopped");
  fm.getInstanceExecutionState = (n: string) => (n in execOverride ? execOverride[n] : byName.get(n)?.exec) ?? null;
  fm.needsYouItems = () => (needsOn ? NEEDS() : []);
  // Fleet → Usage: a report built by the product's own code from made-up daily rows (no transcript is read).
  const { buildUsageReport } = await import(join(REPO, "src/usage-report.ts"));
  const { emptyLedger } = await import(join(REPO, "src/cache-ledger.ts"));
  fm.usageReport = async (params: { range: unknown; group: unknown; only?: string }) => buildUsageReport({ ...USAGE_REPORT_INPUT(fm.usageZone()), range: params.range, group: params.group,
    instances: USAGE_REPORT_INPUT(fm.usageZone()).instances.filter(i => params.only === undefined || i.name === params.only).map(i => ({ ...i, ledger: emptyLedger() })) });
  // Settings → Web → Guests: made-up guest accounts (no guest signs in).
  fm.guestOverview = () => GUEST_OVERVIEW();
  let usageNow: unknown[] = USAGE_ALL;
  fm.getActiveUsageProviderIds = () => new Set((usageNow as Array<{ id: string }>).map(p => p.id));

  fm.initializeWebAuthTokens();
  fm.startHealthServer(PORT);
  await new Promise(r => setTimeout(r, 600));
  const signinCode = () => { fm.initializeWebSessions(); return fm.webLoginCodes.issue({ tier: "admin", epoch: tokenEpoch(fm.webToken) }).display; };

  browser = await chromium.launch({ executablePath: process.env.CHROME, args: ["--no-sandbox"] });
  const base = `http://127.0.0.1:${PORT}`;
  work = mkdtempSync(join(tmpdir(), "agend-readme-hero-out-"));

  // The picture Atlas sends (a small latency chart), drawn by Chromium for each theme like everything else.
  mkdirSync(join(home, "demo"), { recursive: true });
  const CHART_ID = "e".repeat(32);
  async function drawChart(theme: Theme): Promise<void> {
    const dark = theme === "dark";
    const ctx = await browser.newContext({ viewport: { width: 480, height: 260 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    const bars = [62, 64, 61, 98, 100, 97, 18, 16, 17, 15];
    await page.setContent(`<body style="margin:0;font:22px system-ui,sans-serif;background:${dark ? "#1b1e25" : "#fff"};color:${dark ? "#e8ebf1" : "#1d2330"}">
      <div style="padding:16px 18px"><b>p95 latency, /search</b><div style="display:flex;gap:10px;align-items:flex-end;height:150px;margin-top:12px;border-bottom:1px solid ${dark ? "#3a4150" : "#d8deea"}">
      ${bars.map((b, i) => `<div style="flex:1;height:${b}%;border-radius:4px 4px 0 0;background:${i >= 6 ? (dark ? "#56d364" : "#1a7f37") : i >= 3 ? (dark ? "#ff7b72" : "#cf222e") : "#8a94a6"}"></div>`).join("")}
      </div><div style="display:flex;justify-content:space-between;color:${dark ? "#9aa3b2" : "#6b7383"};margin-top:6px"><span>06:00</span><span>index applied</span><span>now</span></div></div></body>`);
    const file = join(home, "demo", `latency-${theme}.png`);
    writeFileSync(file, await page.screenshot({ type: "png" }));
    await ctx.close();
    // The same id, the theme's picture (registered again: the ledger serves only the file it registered).
    fm.webFiles.registerServed({ id: CHART_ID, path: file, instance: "Atlas", name: "latency.png", mime: "image/png", kind: "photo" });
  }
  hooks.drawChart = drawChart;
  await drawChart("light");
  writeFileSync(join(home, "demo", "release-checklist.html"), CHECKLIST);
  // The appearance scene: Sage's own look, written through the agent tools' own checks (a limiter that never refuses:
  // the real one spaces an agent's changes 30 s apart). Its pictures are drawn by Chromium; no effect is placed.
  {
    const { WebAppearance } = await import(join(REPO, "src/web-appearance.ts"));
    const looks = new WebAppearance(fm.themeStore, () => fm.fleetConfig?.web ?? null, () => {},
      { check: () => ({ ok: true }), record() {}, remaining: () => ({}), forget() {} } as never);
    const ok = (r: any, what: string) => { if (!r || r.error || r.errors) throw new Error(`${what}: ${JSON.stringify(r)}`); return r; };
    const draw = async (w: number, h: number, body: string) => {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
      const page = await ctx.newPage(); await page.setContent(`<body style="margin:0">${body}</body>`);
      const png = await page.screenshot({ type: "png" }); await ctx.close();
      return Buffer.from(png).toString("base64");
    };
    const shelf = (n: number, h: number) => Array.from({ length: n }, (_, i) => `<div style="width:${18 + (i * 7) % 14}px;height:${h - (i * 13) % 40}px;border-radius:3px;background:${["#0f766e", "#14b8a6", "#f59e0b", "#e11d48", "#6366f1", "#84cc16"][i % 6]}"></div>`).join("");
    const avatar = ok(looks.handleTool("Sage", "set_web_theme_asset", { slot: "avatar", data_b64: await draw(256, 256,
      `<div style="width:256px;height:256px;display:grid;place-items:center;background:radial-gradient(circle at 30% 25%,#5eead4,#0f766e);font:150px/1 system-ui">📚</div>`) }), "avatar");
    const portrait = ok(looks.handleTool("Sage", "set_web_theme_asset", { slot: "portrait", data_b64: await draw(600, 900,
      `<div style="width:600px;height:900px;background:linear-gradient(160deg,#ccfbf1,#0f766e);display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:0">
        <div style="font:280px/1 system-ui;margin-bottom:60px">📚</div><div style="display:flex;gap:6px;align-items:flex-end;height:150px;padding:0 40px 40px">${shelf(14, 150)}</div></div>`) }), "portrait");
    const banner = ok(looks.handleTool("Sage", "set_web_theme_asset", { slot: "banner", data_b64: await draw(1600, 600,
      `<div style="width:1600px;height:600px;background:linear-gradient(115deg,#f0fdfa 0%,#99f6e4 45%,#0f766e 100%);display:flex;align-items:flex-end;justify-content:center;padding-bottom:150px;box-sizing:border-box">
        <div style="display:flex;gap:8px;align-items:flex-end;height:200px">${shelf(40, 200)}</div></div>`) }), "banner");
    ok(looks.handleTool("Sage", "set_web_theme", { set: {
      colors: { light: { bg: "#f3fbf9", accent: "#0f766e" }, dark: { bg: "#0d1918", accent: "#5eead4" } },
      bubble: { radius: 14, border: "accent" }, font: "inter", workingLabel: "Writing", avatar: avatar.id,
      card: { tagline: "Keeps the docs true to the code", bio: "I write and review the user guides.\nAsk me where something is documented, or to check a page against the code.", portrait: portrait.id, banner: banner.id },
    } }), "theme");
    ok(looks.handleTool("Sage", "set_web_widget", { slot: "chat_header", spec: { v: 1, title: "Docs", items: [
      { type: "progress", label: "Reviewed", key: "reviewed" }, { type: "stat", label: "Open PRs", key: "prs" },
      { type: "badge", label: "State", bind: "state", tones: { working: "info", idle: "ok" } }] }, data: { reviewed: 75, prs: 2 } }), "widget");
    ok(looks.handleTool("Sage", "set_web_ambient", { preset: "fall", glyphs: ["🌸", "❀", "✿"], colors: ["#f4a7b9", "#ffd1dc"], count: 14, duration: [9, 19] }), "ambient");
  }
  // The threads: recorded before any page loads (the page reads them from the history).
  for (const [instance, msgs] of Object.entries(HISTORY)) {
    for (const m of msgs) {
      const base = { instance, ts: minutesAgo(m.at), text: m.text };
      if (m.role === "user") { fm.webChatHistory.record({ ...base, sender: "web-user", role: "user", ...(m.click ? { click: m.click } : {}) }); continue; }
      const attachments: unknown[] = [];
      if (m.file) attachments.push({ id: "f".repeat(32), kind: "document", name: m.file.name, size: m.file.size, mime: "application/pdf" });
      if (m.image) {
        const f = fm.webFiles.servedFile(CHART_ID);
        if (f) attachments.push({ id: f.id, kind: f.kind, name: m.image, size: f.size, mime: f.mime });
      }
      if (m.page) {
        const f = fm.webFiles.registerServed({ id: "d".repeat(32), path: join(home, "demo", m.page), instance, name: m.page, mime: "text/html", kind: "document" });
        if (f) attachments.push({ id: f.id, kind: f.kind, name: f.name, size: f.size, mime: f.mime });
      }
      fm.webChatHistory.record({ ...base, sender: instance, role: "agent", ...(m.buttons ? { buttons: m.buttons } : {}), ...(attachments.length ? { attachments } : {}) });
    }
  }

  async function dashboard(scene: Scene, theme: Theme): Promise<{ file: string; width: number; height: number }> {
    // The host's synced theme decides what the page paints (#1665): set it for this render.
    fm.webPrefs.write(OPERATOR, new Map([["theme", theme]]));
    execOverride = scene.exec ?? {};
    needsOn = !!scene.needs;
    usageNow = scene.usage ?? USAGE_ALL;
    setUsageFetcherForTests(async () => ({ fetchedAt: new Date().toISOString(), providers: usageNow }) as never);
    await scene.before?.(theme);
    const ctx = await browser.newContext({ viewport: scene.viewport, deviceScaleFactor: 2, colorScheme: theme, locale: "en-US" });
    await ctx.addInitScript({ content: `try {
      localStorage.setItem("agend_tour_done", "1"); localStorage.setItem("agend_firstrun_dismissed", "1");
      localStorage.setItem("agend_usage_rail", ${JSON.stringify(scene.rail ? "1" : "0")}); localStorage.setItem("agend_theme", ${JSON.stringify(theme)});
      localStorage.setItem("agend_text_size", ${JSON.stringify(process.env.TEXT_SIZE || "m")});
      localStorage.setItem("agend_html_preview", "on");
    } catch {}` });
    const page = await ctx.newPage();
    page.on("pageerror", (e: Error) => errors.push(`${scene.name} ${theme}: ${String(e).slice(0, 200)}`));
    await page.goto(`${base}/signin`); await page.waitForSelector("#code");
    await page.fill("#code", signinCode()); await page.click("#go"); await page.waitForURL(`${base}/ui`);
    await page.goto(`${base}${scene.path}`);
    const want = scene.path.startsWith("/ui/chat/") ? HISTORY[scene.path.slice("/ui/chat/".length)]?.length ?? 0 : 0;
    if (want) await page.waitForFunction((n: number) => document.querySelectorAll(".p-chat .msg").length >= n, want, { timeout: 20_000 });
    await page.waitForTimeout(1500);                                      // avatars, the usage rail, fonts
    await scene.prepare?.(page);
    // MEASURE=1: where things are (viewport CSS px), for laying out hero.html. A string: tsx would rename helpers.
    if (process.env.MEASURE) console.log(scene.name, theme, await page.evaluate(`JSON.stringify((() => {
      const r = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.right), Math.round(b.bottom)]; };
      const rail = document.querySelector(".u-rail"), body = rail && rail.querySelector(".u-rail-body");
      const kids = body ? [...body.querySelectorAll("*")].filter((e) => e.getBoundingClientRect().height > 0) : [];
      const bottom = kids.reduce((m, e) => Math.max(m, e.getBoundingClientRect().bottom), 0);
      return { rail: r(rail), railContentBottom: Math.round(bottom), firstMsg: r(document.querySelector(".p-chat .msg")), table: r(document.querySelector(".p-chat table")), composer: r(document.querySelector("#msgIn")) };
    })())`));
    const clip = (await scene.clip?.(page)) ?? null;
    const file = join(work!, `${scene.name}-${theme}.png`);
    await page.screenshot({ path: file, ...(clip ? { clip } : {}) });
    await ctx.close();
    return { file, width: clip?.width ?? scene.viewport.width, height: clip?.height ?? scene.viewport.height };
  }

  /** A page (hero.html or frame.html) screenshotted at 2× and encoded as WebP by the browser. */
  async function encode(url: URL, viewport: { width: number; height: number }, theme: Theme, ready: string, out: string, measure?: string): Promise<void> {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, colorScheme: theme });
    const page = await ctx.newPage();
    page.on("pageerror", (e: Error) => errors.push(`${out}: ${String(e).slice(0, 200)}`));
    await page.goto(url.href);
    await page.waitForFunction((k: string) => (window as any)[k] === true, ready, { timeout: 20_000 });
    if (process.env.MEASURE && measure) console.log(`hero ${theme}`, await page.evaluate(measure));
    const png = await page.screenshot({ type: "png" });
    // WebP, encoded by the browser: no image tool needed beyond Chromium.
    const b64: string = await page.evaluate(async ({ data, q }: { data: string; q: number }) => {
      const img = new Image(); img.src = `data:image/png;base64,${data}`; await img.decode();
      const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext("2d")!.drawImage(img, 0, 0);
      return c.toDataURL("image/webp", q).split(",")[1]!;
    }, { data: Buffer.from(png).toString("base64"), q: QUALITY });
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, Buffer.from(b64, "base64"));
    console.log(`${out}: ${Math.round(readFileSync(out).length / 1024)} KB`);
    await ctx.close();
  }

  for (const scene of SCENES) {
    if (ONLY.size && !ONLY.has(scene.name)) continue;
    for (const theme of ["light", "dark"] as const) {
      const shot = await dashboard(scene, theme);
      const out = join(OUT, `${scene.out}-${theme}.webp`);
      if (scene.hero) {
        const url = pathToFileURL(join(HERE, "hero.html"));
        url.searchParams.set("theme", theme); url.searchParams.set("shot", pathToFileURL(shot.file).href);
        await encode(url, { width: 1280, height: 720 }, theme, "heroReady", out,
          `JSON.stringify([".screen", ".msgs", ".typing", ".chip", ".b.bot"].map((s) => { const b = document.querySelector(s).getBoundingClientRect(); return [s, Math.round(b.top), Math.round(b.bottom)]; }))`);
      } else {
        const url = pathToFileURL(join(HERE, "frame.html"));
        for (const [k, v] of [["theme", theme], ["shot", pathToFileURL(shot.file).href], ["w", String(shot.width)], ["h", String(shot.height)]]) url.searchParams.set(k!, v!);
        await encode(url, { width: shot.width + 64, height: shot.height + 56 }, theme, "frameReady", out);
      }
    }
  }
} finally {
  try { await browser?.close(); } catch { /* already gone */ }
  try { fm?.healthServer?.close?.(); } catch { /* already closed */ }
  rmSync(home, { recursive: true, force: true });
  if (work) rmSync(work, { recursive: true, force: true });
}
if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
process.exit(0);
