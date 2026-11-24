/**
 * M-3559: in a short window the sidebar's nav rows sit two to a line (max-height 500 px) and the search row is 122 px wide:
 * its label was cut to 「搜.」 beside the Ctrl K hint. The label never gives way: where the row is too narrow for both, the
 * hint goes (a container query on the row: about 140 px inside its padding are needed for icon, label, gaps and "Ctrl K").
 * The row's title still names the shortcut. The real-browser measure (each case's row width, label clipped or not, hint
 * shown or not, in the real Hub) is in docs/evidence/sidebar-search-label-m3559/.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(process.cwd(), "src/ui/shared/app.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

describe("M-3559: the search row's label never gives way to its shortcut hint", () => {
  it("the row is its own container; below 145 px inside it the hint goes, and nothing else", () => {
    expect(css).toMatch(/\.side-search\s*\{\s*container-type:\s*inline-size;\s*\}/);
    const q = /@container\s*\(max-width:\s*(\d+)px\)\s*\{\s*([^{}]+)\{\s*display:\s*none;\s*\}\s*\}/g;
    const rules = [...css.matchAll(q)].filter((m) => m[2].includes(".side-search"));
    expect(rules.map((m) => [Number(m[1]), m[2].trim()])).toEqual([[144, ".side-search .kbd-hint"]]);
    // The two-to-a-line row (122 px, 98 px inside its 12 px padding) hides it; the narrowest one-column row (184 px) keeps it.
    expect(122 - 24).toBeLessThanOrEqual(144);
    expect(184 - 24).toBeGreaterThan(144);
  });
  it("both sidebars' search rows carry the class and keep the shortcut in their title", () => {
    for (const [file, title] of [["src/ui/shared/app-shell.js", 't("app.searchTitle", searchShortcut())'], ["src/ui/panel-hub.js", "(${searchShortcut()})"]]) {
      const src = readFileSync(join(process.cwd(), file), "utf8");
      const row = src.slice(src.indexOf('class="side-row side-search"'), src.indexOf("</button>", src.indexOf('class="side-row side-search"')));
      expect(row, file).toContain('<kbd class="kbd-hint"');
      expect(row, file).toContain(title);
    }
  });
});
