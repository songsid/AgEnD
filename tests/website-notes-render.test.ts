/**
 * Engineering Notes, rendered (#2263 review): the real `astro build` of a copy of the website whose posts are
 * tests/fixtures/website-notes — a published post and its translation, a post whose translation is a draft, a draft,
 * and a post only in zh-TW. It checks what the pages say, not the source: drafts are neither listed nor routed, the
 * list is newest first, a post has its own title, description and date, the language switch goes to the translation
 * or (none, or a draft) to the other list, and the shared nav links lead to the home page's sections.
 * Needs the website's own dependencies (website/node_modules). Without them it is skipped, and says so by name; with
 * AGEND_WEBSITE_BUILD_TEST=1 a missing dependency fails it instead.
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const SITE = join(ROOT, "website");
const ASTRO = join(SITE, "node_modules", "astro", "bin", "astro.mjs");
const FIXTURES = join(ROOT, "tests", "fixtures", "website-notes");

const REQUIRED = process.env.AGEND_WEBSITE_BUILD_TEST === "1";
// PR CI does not install the website's dependencies (the leader's call, 2026-10-20: deploy-website builds the real site
// on every main push). The skip says so, in the suite's name and on the console, so it never reads as a pass.
const SKIP_REASON = "skipped: website deps not installed (run `npm ci --prefix website`)";
const SKIPPED = !existsSync(ASTRO) && !REQUIRED;
if (SKIPPED) console.warn(`[website-notes-render] ${SKIP_REASON}`);

describe.skipIf(SKIPPED)(SKIPPED ? `Engineering Notes, built from fixtures — ${SKIP_REASON}` : "Engineering Notes, built from fixtures", { timeout: 240_000 }, () => {
  let dir = "", dist = "";
  beforeAll(() => {
    if (!existsSync(ASTRO)) throw new Error("AGEND_WEBSITE_BUILD_TEST=1 but the website's dependencies are not installed: npm ci --prefix website");
    // Inside website/, so the copy finds the website's node_modules the usual way (a parent directory), not via a link.
    dir = mkdtempSync(join(SITE, ".notes-fixture-build-"));
    for (const entry of ["src", "public", "astro.config.mjs", "package.json", "tsconfig.json"]) cpSync(join(SITE, entry), join(dir, entry), { recursive: true });
    rmSync(join(dir, "src", "content", "notes"), { recursive: true, force: true });
    cpSync(FIXTURES, join(dir, "src", "content", "notes"), { recursive: true });
    // Without the Vite variables vitest sets in its own environment (BASE_URL=/ would replace the site's /AgEnD base).
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(?:BASE_URL|MODE|DEV|PROD|SSR|VITEST.*|NODE_ENV)$/.test(k)));
    const r = spawnSync(process.execPath, [ASTRO, "build"], { cwd: dir, encoding: "utf8", timeout: 230_000, env: { ...env, ASTRO_TELEMETRY_DISABLED: "1" } });
    if (r.status !== 0) throw new Error(`astro build ended ${r.status ?? r.signal}:\n${r.stdout}${r.stderr}`);
    dist = join(dir, "dist");
  }, 240_000);
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });
  const page = (path: string) => readFileSync(join(dist, path, "index.html"), "utf8");
  const routed = (path: string) => existsSync(join(dist, path, "index.html"));
  /** The language switch in the nav: the link labelled with the other language. */
  const switchOf = (html: string) => /<a href="([^"]+)"[^>]*>\s*(?:中文|EN)\s*<\/a>/.exec(html)?.[1];

  it("a draft is neither listed nor routed, in either language", () => {
    expect(routed("notes/hidden")).toBe(false);
    expect(page("notes")).not.toContain("Hidden draft");
    expect(routed("zh-tw/notes/older")).toBe(false);
    expect(page("zh-tw/notes")).not.toContain("較舊的文章（草稿）");
    for (const path of ["notes/newer", "notes/older", "zh-tw/notes/newer", "zh-tw/notes/zh-only"]) expect(routed(path), path).toBe(true);
  });
  it("each list is newest first, with date, summary and tags, linking to the post", () => {
    const en = page("notes"), zh = page("zh-tw/notes");
    expect(en.indexOf("Newer post")).toBeLessThan(en.indexOf("Older post"));
    expect(zh.indexOf("較新的文章")).toBeLessThan(zh.indexOf("只有中文"));
    expect(en).toContain('href="/AgEnD/notes/newer/"');
    expect(en).toMatch(/<time datetime="2026-02-01"[^>]*>2026-02-01<\/time>/);
    expect(en).toContain("The newer one.");
    expect(en).toContain(">stability<");
    expect(en).not.toContain("No posts yet.");
  });
  it("a post: its own title, description and type; its date, summary, tags and body", () => {
    const html = page("notes/newer");
    expect(html).toContain("<title>Newer post — AgEnD</title>");
    expect(html).toContain('<meta name="description" content="The newer one.">');
    expect(html).toContain('<meta property="og:type" content="article">');
    expect(html).toMatch(/<time datetime="2026-02-01"[^>]*>2026-02-01<\/time>/);
    expect(html).toContain("Body of Newer post.");
    expect(page("zh-tw/notes/newer")).toContain("<title>較新的文章 — AgEnD</title>");
  });
  it("the language switch: to the translation; with none, or only a draft, to the other list", () => {
    expect(switchOf(page("notes/newer"))).toBe("/AgEnD/zh-tw/notes/newer/");
    expect(switchOf(page("zh-tw/notes/newer"))).toBe("/AgEnD/notes/newer/");
    expect(switchOf(page("notes/older"))).toBe("/AgEnD/zh-tw/notes/");          // its translation is a draft
    expect(switchOf(page("zh-tw/notes/zh-only"))).toBe("/AgEnD/notes/");       // no translation
    expect(switchOf(page("notes"))).toBe("/AgEnD/zh-tw/notes/");
  });
  it("the nav: section links stay anchors on the home pages and lead back to them elsewhere; the logo goes home", () => {
    expect(page("")).toContain('href="#features"');
    expect(page("zh-tw")).toContain('href="#features"');
    expect(page("notes")).toContain('href="/AgEnD/#features"');
    expect(page("zh-tw/notes/newer")).toContain('href="/AgEnD/zh-tw/#features"');
    expect(page("zh-tw/notes")).toMatch(/<a href="\/AgEnD\/zh-tw\/" class="flex items-center gap-2"/);
    for (const path of ["", "zh-tw", "notes/newer"]) expect(page(path)).toContain(path.startsWith("zh-tw") ? 'href="/AgEnD/zh-tw/notes/"' : 'href="/AgEnD/notes/"');
  });
});
