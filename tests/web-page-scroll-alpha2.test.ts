/**
 * alpha.2 (user report, Edge on Windows): /ui/chat had two vertical scrollbars — the thread's and the whole page's.
 * Cause: the sidebar's instance rows carry .sr-only labels (position: absolute). Neither their scroll container
 * (.side-section) nor the shell was positioned, so their containing block was the viewport: they escaped every
 * overflow clip, and with a long instance list the rows below the fold made the page itself taller than the window.
 *
 * What a browser does with that is checked by the real-browser sweep (every shell page: scrollHeight ≤ clientHeight).
 * This pins the CSS that prevents it, rule by rule, so a refactor that drops one is caught without a browser.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(join(process.cwd(), "src", "ui", "shared", "app.css"), "utf8");
/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(?:^|\\n|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(CSS);
  expect(m, `a rule for ${selector}`).not.toBeNull();
  return Object.fromEntries(m![1]!.split(";").map(d => d.split(":").map(x => x.trim())).filter(([k, v]) => k && v).map(([k, v]) => [k!, v!]));
}

describe("the app's page never scrolls; only its panes do (alpha.2)", () => {
  it("the shell clips what it holds: overflow hidden AND a containing block for absolute descendants", () => {
    const shell = rule(".shell");
    expect([shell.overflow, shell.position]).toEqual(["hidden", "relative"]);
  });
  it("the sidebar's scroll container is the containing block of its rows' .sr-only labels", () => {
    const side = rule(".side-section");
    expect([side["overflow-y"], side.position]).toEqual(["auto", "relative"]);
  });
  it("the page itself is not scrollable while the shell is shown (a guard; the sweep still measures scrollHeight)", () => {
    expect(rule("html:has(.shell), html:has(.shell) body").overflow).toBe("hidden");
  });
});
