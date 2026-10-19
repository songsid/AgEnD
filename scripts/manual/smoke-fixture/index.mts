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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fixtureInstances, CLASSIC_ROOMS, TEAMS, type FixtureInstance } from "./data.mts";
import { drawPicture, PICTURES, type PictureSpec } from "./pictures.mts";
import { LAN_HOST } from "./from-defaults.mts";

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
  /**
   * Set a theme the way the product would accept it: a card's tagline/bio must pass the product's own canonical
   * checks (ThemeStore.setTheme does not validate), the write must succeed, and the card must read back unchanged.
   * Throws otherwise. Deliberate refusal cases call the store directly and label themselves.
   */
  seedTheme(name: string, theme: Record<string, any>): any;
  /** Draw a picture (PNG bytes). */
  picture(spec: PictureSpec | keyof typeof PICTURES): Promise<Buffer>;
  close(): Promise<void>;
}

/** Can this process bind 127.0.0.1:port right now? (Never a request to whatever holds it.) */
function portFree(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}
async function until(test: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (test()) return true; await new Promise(r => setTimeout(r, 25)); }
  return test();
}

/**
 * Boot the fixture: scratch home, fleet.yaml + classicBot.yaml, FleetManager (web server only), Chromium.
 * It browses only listeners it proves it owns: both ports must be free first, and the fleet's own health and preview
 * servers must be bound to them before a page opens. Anything it acquires is released by close(), which is
 * idempotent and also runs on an uncaught error, a rejection, SIGINT or SIGTERM (then the process exits 1).
 */
export async function bootFixture(o: FixtureOptions): Promise<Fixture> {
  const REPO = process.env.REPO; if (!REPO) throw new Error("set REPO=<checkout>");
  const PW = process.env.PW_DIR; if (!PW) throw new Error("set PW_DIR=<dir with playwright-core>");
  if (!process.env.FONTCONFIG_FILE) process.env.FONTCONFIG_FILE = "/etc/fonts/fonts.conf";
  for (const p of [o.port, o.port + 1]) if (!(await portFree(p))) throw new Error(`port ${p} is in use: refusing to boot (the fixture never talks to a listener it did not start)`);
  const dir = mkdtempSync(join(tmpdir(), "smoke-fx-"));
  process.env.AGEND_HOME = dir;
  let fm: any = null, browser: any = null, closed: Promise<void> | null = null;
  // Each step on its own: one that throws never skips the rest. Output artifacts (OUT) are not touched.
  const close = (): Promise<void> => closed ??= (async () => {
    const step = async (what: string, fn: () => unknown) => { try { await fn(); } catch (e) { console.error(`fixture close: ${what}: ${String(e).slice(0, 160)}`); } };
    await step("browser", () => browser?.close());
    await step("health listener", () => new Promise<void>(r => { const srv = fm?.healthServer; if (!srv) return r(); srv.closeAllConnections?.(); srv.close(() => r()); fm.healthServer = null; }));
    await step("preview listener", () => fm?.stopPreviewListener?.());
    await step("scratch home", () => rmSync(dir, { recursive: true, force: true }));
    process.off("uncaughtException", onFatal); process.off("unhandledRejection", onFatal); process.off("SIGINT", onSignal); process.off("SIGTERM", onSignal);
  })();
  const onFatal = (e: unknown) => { console.error(e); void close().finally(() => process.exit(1)); };
  const onSignal = () => { void close().finally(() => process.exit(1)); };
  process.on("uncaughtException", onFatal); process.on("unhandledRejection", onFatal); process.on("SIGINT", onSignal); process.on("SIGTERM", onSignal);
  // A store can still flush after close() (a debounced write recreates the folder): remove the home again at exit.
  process.once("exit", () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  try {                                                  // BEFORE fleet-manager is imported
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
  const { canonicalTagline, canonicalBio } = await import(REPO + "/src/web-theme.ts");
  fm = new FleetManager(dir);
  fm.healthPortRetried = true;   // never the EADDRINUSE takeover path: a busy port fails the boot instead
  const quiet = () => {}; fm.logger = { info: quiet, warn: quiet, error: quiet, debug: quiet, trace: quiet, fatal: quiet, child: () => fm.logger };
  fm.notifyFleetError = () => true;
  fm.loadConfig(join(dir, "fleet.yaml"));
  fm.lifecycle = { isPaused: () => false, hasWorkLease: () => false, daemons: new Map() };
  const status = new Map(instances.map(i => [i.name, i.status ?? "running"]));
  fm.getInstanceStatus = (n: string) => status.get(n) ?? "running";
  fm.initializeWebAuthTokens(); fm.startHealthServer(o.port);
  // Our own servers, bound to the ports we checked — before any page is opened.
  const owns = (srv: any, port: number) => { const a = srv?.listening ? srv.address() : null; return !!a && typeof a === "object" && a.port === port && a.address === "127.0.0.1"; };
  if (!(await until(() => fm.healthServerListening === true && owns(fm.healthServer, o.port), 10000))) throw new Error(`the fixture's health listener did not bind 127.0.0.1:${o.port}`);
  if (!(await until(() => fm.previewListening === true && owns(fm.previewListener?.server, o.port + 1), 10000))) throw new Error(`the fixture's preview listener did not bind 127.0.0.1:${o.port + 1}`);
  const code = () => { fm.initializeWebSessions(); return fm.webLoginCodes.issue({ tier: "admin", epoch: tokenEpoch(fm.webToken) }).display; };
  // PW_ENGINE=webkit runs the same smoke in WebKit (Safari's engine; its system libraries come with the Playwright
  // image, e.g. mcr.microsoft.com/playwright). Default: CHROME if set, else playwright-core's own Chromium
  // (`npx playwright-core install chromium` in PW_DIR).
  // from-defaults.mts: dashboard.lan.example resolves to the fixture, so a page can be on a real non-loopback origin
  // (Chromium only: WebKit has no host resolver rules).
  const engine = process.env.PW_ENGINE === "webkit" ? "webkit" : "chromium";
  const pw = createRequire(PW + "/")("playwright-core");
  browser = engine === "webkit" ? await pw.webkit.launch()
    : await pw.chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: ["--no-sandbox", `--host-resolver-rules=MAP ${LAN_HOST} 127.0.0.1`],
      // PW_SCROLLBARS=1: classic scrollbars that take width, as on Windows (headless hides them by default).
      ...(process.env.PW_SCROLLBARS === "1" ? { ignoreDefaultArgs: ["--hide-scrollbars"] } : {}) });
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
    seedTheme(name, theme) {
      const card = theme.card ? { ...theme.card } : undefined;
      if (card?.tagline !== undefined) { const t = canonicalTagline(card.tagline); if (t === null || t !== card.tagline) throw new Error(`seed tagline for ${name} is not canonical: ${String(card.tagline).slice(0, 40)}…`); }
      if (card?.bio !== undefined) { const b = canonicalBio(card.bio); if (b === null || b !== card.bio) throw new Error(`seed bio for ${name} is not canonical: ${String(card.bio).slice(0, 40)}…`); }
      const set = fm.themeStore.setTheme(name, theme, "agent");
      if (!set || set.ok === false) throw new Error(`seed theme for ${name} refused: ${JSON.stringify(set).slice(0, 160)}`);
      const back = fm.themeStore.get(name).theme?.card;
      for (const k of ["tagline", "bio", "portrait", "banner"]) if (card?.[k] !== undefined && back?.[k] !== card[k]) throw new Error(`seed card ${k} for ${name} did not read back`);
      return set;
    },
    picture: (spec) => drawPicture(painter, typeof spec === "string" ? PICTURES[spec] : spec),
    close,
  };
  } catch (e) { await close(); throw e; }
}

/** Save a screenshot under OUT/<smoke>/<case>-<name>.png and return its path. */
export function shotPath(smoke: string, c: MatrixCase | string, name: string): string {
  const out = join(process.env.OUT ?? join(tmpdir(), "smoke-out"), smoke);
  mkdirSync(out, { recursive: true });
  return join(out, `${typeof c === "string" ? c : caseName(c)}-${name}.png`);
}
export * from "./seed.mts";
export * from "./from-defaults.mts";
