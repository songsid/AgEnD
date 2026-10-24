/**
 * #2585: the Office's editors open a native <dialog> (Edit offices, …) as a child of `.oo`. The rule that gives
 * `.oo`'s bars and notes their side margins (#2542) must not reach it: a modal dialog centres itself with `margin: auto`
 * (a phone: a bottom sheet, `margin: auto 0 0`), and side margins pinned it to the left edge, over the sidebar.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(join(process.cwd(), "src", "ui", "shared", "app.css"), "utf8");

describe("the Office's side margins leave its dialogs alone", () => {
  it("every `.oo > …` rule that sets side margins excludes dialog (desk and phone)", () => {
    const rules = [...CSS.matchAll(/(\.oo\s*>\s*[^{]+)\{([^}]*)\}/g)].filter(([, , body]) => /margin-(left|right)/.test(body));
    expect(rules.length).toBeGreaterThanOrEqual(2);
    for (const [, selector] of rules) expect(selector).toContain(":not(dialog)");
  });
});
