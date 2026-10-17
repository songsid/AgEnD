/**
 * The shared realistic smoke fixture (#2038 lesson: one flat PNG and a few short names hid real bugs). Every smoke
 * under scripts/manual/smoke/ boots the product's own web server from an in-process FleetManager in a scratch home
 * seeded here — about 60 instances (long Latin and CJK names, teams, ClassicBot rooms), detailed pictures at real
 * sizes, text at the caps — and opens real Chromium pages over a matrix: desktop 1366 / phone 390, light / dark,
 * English / zh-TW.
 *
 * Rules it keeps (see README.md): no fleet start (no CLI, no tmux, never reconcile/startInstance); AGEND_HOME is a
 * fresh scratch dir set BEFORE fleet-manager is imported; playwright-core from PW_DIR, Chrome from CHROME; a fresh
 * sign-in code per browser context; tour and first-run overlays skipped.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fixtureInstances, CLASSIC_ROOMS, TEAMS, type FixtureInstance } from "./data.mts";
import { drawPicture, PICTURES, type PictureSpec } from "./pictures.mts";

export * from "./data.mts";
export * from "./pictures.mts";

export interface MatrixCase { device: "desk" | "phone"; theme: "light" | "dark"; lang: "en" | "zh-TW" }
export const VIEWPORTS = { desk: { width: 1366, height: 900 }, phone: { width: 390, height: 844 } } as const;

/** MATRIX=full (8 cases, default) | quick (desk-light-en + phone-dark-zh-TW) | e.g. "desk-dark-zh-TW,phone-light-en". */
export function matrix(spec = process.env.MATRIX ?? "full"): MatrixCase[] {
  const all: MatrixCase[] = [];
  for (const device of ["desk", "phone"] as const) for (const theme of ["light", "dark"] as const) for (const lang of ["en", "zh-TW"] as const) all.push({ device, theme, lang });
  if (spec === "full") return all;
  if (spec === "quick") return [all[0], all[7]];
  const want = new Set(spec.split(","));
  return all.filter(c => want.has(caseName(c)));
}
export const caseName = (c: MatrixCase) => `${c.device}-${c.theme}-${c.lang}`;
/** A product label in the case's language: locators must not be English-only, or zh-TW cases silently skip a check. */
export const labelOf = (c: MatrixCase, l: { en: string; zh: string }) => c.lang === "zh-TW" ? l.zh : l.en;

export interface FixtureOptions {
  /** Health port; the preview origin is port + 1. Each smoke has its own default. */
  port: number;
  /** Extra YAML appended under `web:` (indented two spaces), e.g. appearance caps. */
  webYaml?: string;
  /** Use the full ~60-instance fleet (default) or only the first `instances` of it. */
  instances?: number;
  /** Write classicBot.yaml rooms (default true). */
  classic?: boolean;
}

export interface Fixture {
  fm: any;
  dir: string;
  base: string;
  instances: FixtureInstance[];
  browser: any;
  /** A signed-in page for one matrix case (fresh context, overlays skipped, host theme pref set). */
  page(c: MatrixCase, opts?: { path?: string; storage?: Record<string, string>; prefs?: Record<string, string> }): Promise<{ ctx: any; page: any; csp: () => Promise<string[]> }>;
  /** Draw a picture (PNG bytes). */
  picture(spec: PictureSpec | keyof typeof PICTURES): Promise<Buffer>;
  close(): Promise<void>;
}

/** Boot the fixture: scratch home, fleet.yaml + classicBot.yaml, FleetManager (web server only), Chromium. */
export async function bootFixture(o: FixtureOptions): Promise<Fixture> {
  const REPO = process.env.REPO; if (!REPO) throw new Error("set REPO=<checkout>");
  const PW = process.env.PW_DIR; if (!PW) throw new Error("set PW_DIR=<dir with playwright-core>");
  if (!process.env.FONTCONFIG_FILE) process.env.FONTCONFIG_FILE = "/etc/fonts/fonts.conf";
  const dir = mkdtempSync(join(tmpdir(), "smoke-fx-"));
  process.env.AGEND_HOME = dir;                                                  // BEFORE fleet-manager is imported
  const instances = fixtureInstances().slice(0, o.instances ?? 60);
  const q = (s: string) => JSON.stringify(s);
  const teams = TEAMS.map(t => ({ t, members: instances.filter(i => i.team === t).map(i => i.name) })).filter(x => x.members.length);
  const yaml = [
    `health_port: ${o.port}`,
    "instances:",
    ...instances.flatMap(i => [
      `  ${q(i.name)}:`, `    working_directory: ${q(dir)}`, `    backend: ${i.backend}`,
      ...(i.general ? ["    general_topic: true"] : []),
      ...(i.displayName ? [`    display_name: ${q(i.displayName)}`] : []),
      ...(i.description ? [`    description: ${q(i.description)}`] : []),
    ]),
    ...(teams.length ? ["teams:", ...teams.flatMap(({ t, members }) => [`  ${q(t)}:`, `    members: [${members.map(q).join(", ")}]`])] : []),
    "web:", `  preview_port: ${o.port + 1}`, ...(o.webYaml ? [o.webYaml] : []),
  ].join("\n") + "\n";
  writeFileSync(join(dir, "fleet.yaml"), yaml);
  if (o.classic !== false) {
    writeFileSync(join(dir, "classicBot.yaml"), "channels:\n" + CLASSIC_ROOMS.map((r, n) =>
      `  room${n}:\n    channelId: ${q(r.channelId)}\n    adapterId: telegram\n    instanceName: ${q(r.instanceName)}\n    name: ${q(r.name)}\n    backend: ${r.backend}\n`).join(""));
  }
  const { FleetManager } = await import(REPO + "/src/fleet-manager.ts");
  const { tokenEpoch } = await import(REPO + "/src/web-session.ts");
  const fm: any = new FleetManager(dir);
  const quiet = () => {}; fm.logger = { info: quiet, warn: quiet, error: quiet, debug: quiet, trace: quiet, fatal: quiet, child: () => fm.logger };
  fm.notifyFleetError = () => true;
  fm.loadConfig(join(dir, "fleet.yaml"));
  fm.lifecycle = { isPaused: () => false, hasWorkLease: () => false, daemons: new Map() };
  const status = new Map(instances.map(i => [i.name, i.status ?? "running"]));
  fm.getInstanceStatus = (n: string) => status.get(n) ?? "running";
  fm.initializeWebAuthTokens(); fm.startHealthServer(o.port);
  await new Promise(r => setTimeout(r, 600));
  const code = () => { fm.initializeWebSessions(); return fm.webLoginCodes.issue({ tier: "admin", epoch: tokenEpoch(fm.webToken) }).display; };
  const { chromium } = createRequire(PW + "/")("playwright-core");
  const browser = await chromium.launch({ executablePath: process.env.CHROME ?? process.env.HOME + "/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome", args: ["--no-sandbox"] });
  const base = `http://127.0.0.1:${o.port}`;
  const painter = await browser.newPage();
  return {
    fm, dir, base, instances, browser,
    async page(c, opts = {}) {
      // Theme and language are host preferences (#1665): set on the host, every page follows them.
      // Every case starts from the same prefs: what a previous case set (a card size, a filter) is cleared first.
      const stale = Object.keys(fm.webPrefs.read("operator").values ?? {}).map(k => [k, null] as [string, null]);
      fm.webPrefs.write("operator", new Map<string, unknown>([...stale, ["theme", c.theme], ["lang", c.lang], ...Object.entries(opts.prefs ?? {})]));
      const ctx = await browser.newContext({ viewport: VIEWPORTS[c.device], deviceScaleFactor: 1, colorScheme: c.theme, locale: c.lang === "zh-TW" ? "zh-TW" : "en-US",
        isMobile: c.device === "phone", hasTouch: c.device === "phone" });
      const storage = { agend_tour_done: "1", agend_firstrun_dismissed: "1", agend_usage_rail: "0", agend_lang: c.lang, ...(opts.storage ?? {}) };
      await ctx.addInitScript({ content: `try { ${Object.entries(storage).map(([k, v]) => `localStorage.setItem(${q(k)}, ${q(v)});`).join(" ")} } catch {}
        window.__csp = []; document.addEventListener("securitypolicyviolation", e => window.__csp.push(e.violatedDirective + " " + (e.blockedURI || "")));` });
      const page = await ctx.newPage();
      await page.goto(`${base}/signin`); await page.waitForSelector("#code"); await page.fill("#code", code()); await page.click("#go"); await page.waitForURL(`${base}/ui`);
      if (opts.path) { await page.goto(base + opts.path); }
      await page.waitForTimeout(500);
      return { ctx, page, csp: async () => page.evaluate("window.__csp || []") as Promise<string[]> };
    },
    picture: (spec) => drawPicture(painter, typeof spec === "string" ? PICTURES[spec] : spec),
    async close() { await browser.close(); fm.webServer?.close?.(); },
  };
}

/** Save a screenshot under OUT/<smoke>/<case>-<name>.png and return its path. */
export function shotPath(smoke: string, c: MatrixCase | string, name: string): string {
  const out = join(process.env.OUT ?? join(tmpdir(), "smoke-out"), smoke);
  mkdirSync(out, { recursive: true });
  return join(out, `${typeof c === "string" ? c : caseName(c)}-${name}.png`);
}
export * from "./seed.mts";
