/**
 * #1922: no empty band between the sidebar's filter block and its footer. The two --s-2 paddings used to stack with
 * nothing between them (~20 px). Now the filter block ends with --s-1, the footer starts with --s-1 under a divider,
 * so the gap reads as a section break. Measured in Chromium (light/dark, desktop and the phone drawer, facets folded and
 * open): 16 px of nothing → 4 px + a 1 px divider + 4 px.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(join(process.cwd(), "src/ui/shared/app.css"), "utf8");
const rule = (selector: string) => {
  const m = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`).exec(CSS);
  return m ? m[1]!.trim() : null;
};

describe("the sidebar's filter block and footer (#1922)", () => {
  it("the filter block ends with --s-1, the footer starts with --s-1 under a divider", () => {
    expect(rule(".v-filter")).toContain("padding: var(--s-2) var(--s-3) var(--s-1);");
    const foot = rule(".side-foot");
    expect(foot).toContain("padding: var(--s-1) var(--s-2) var(--s-2);");
    expect(foot).toContain("border-top: 1px solid var(--border);");
  });
});
