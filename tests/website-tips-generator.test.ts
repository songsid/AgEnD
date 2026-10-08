/**
 * Website tips page consistency: generated output must match committed artifacts.
 *
 * Why this approach:
 *   CI runs `npm run build` (postbuild re-generates website/public/tips-*.html)
 *   BEFORE running tests. If the test read the generated files from the
 *   filesystem, build would always overwrite any stale committed artifact first
 *   — so "changed src/tips.ts without regenerating" would never be detected.
 *
 *   Instead: call the real renderPage() from src/website-tips-renderer.ts and
 *   compare its output against the committed files via `git show HEAD:path`.
 *   git HEAD is the commit being tested, so the comparison is always between
 *   "what the current source would generate" and "what was committed" —
 *   stale artifacts fail regardless of what postbuild wrote to disk.
 */
import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { TIPS } from "../src/tips.js";
import { renderPage } from "../src/website-tips-renderer.js";

/** Read a file as it was committed at HEAD — immune to postbuild overwrites. */
function gitShow(repoRelPath: string): string {
  return execSync(`git show HEAD:${repoRelPath}`, { cwd: process.cwd() }).toString();
}

describe("website tips pages", () => {
  it.each(["en", "zh"] as const)("contains every tip in the %s page", locale => {
    // Read the filesystem version (post-postbuild) for structural checks.
    // These assertions detect regressions in tip count / level distribution
    // rather than source-vs-artifact staleness.
    const html = renderPage(TIPS as Parameters<typeof renderPage>[0], locale);
    expect(html.match(/data-tip-id="tip-\d{3}"/g)).toHaveLength(TIPS.length);
    expect(html.match(/data-level="beginner"/g)).toHaveLength(104);
    expect(html.match(/data-level="intermediate"/g)).toHaveLength(100);
    expect(html.match(/data-level="advanced"/g)).toHaveLength(100);
  });

  it.each(["en", "zh"] as const)(
    "committed tips-%s.html matches what the current source would generate",
    locale => {
      // Mutation guard: if src/tips.ts is changed without regenerating and
      // committing website/public/tips-{locale}.html, this test fails in CI.
      //
      // The test calls the real renderPage() (not a copied escapeHtml), so
      // any change to the render logic is also caught here.
      const generated = renderPage(TIPS as Parameters<typeof renderPage>[0], locale);
      const committed = gitShow(`website/public/tips-${locale}.html`);
      expect(generated).toBe(committed);
    },
  );

  it("keeps the two locales separate and linked", () => {
    const en = renderPage(TIPS as Parameters<typeof renderPage>[0], "en");
    const zh = renderPage(TIPS as Parameters<typeof renderPage>[0], "zh");
    expect(en).toContain(TIPS[0].text_en);
    expect(en).not.toContain(TIPS[0].text_zh);
    expect(en).toContain('href="./tips-zh.html"');
    expect(zh).toContain(TIPS[0].text_zh);
    expect(zh).not.toContain(TIPS[0].text_en);
    expect(zh).toContain('href="./tips-en.html"');
  });
});
