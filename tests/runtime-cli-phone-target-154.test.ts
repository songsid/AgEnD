import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * AGEND-154 (Prism P2-3 on #3552): the Install / Update buttons in a paired computer's CLI list are `.btn.btn-sm` (min-height 30px) and none of the phone rules of app.css matches that markup.
 * The measured result (a real Chromium, current CSS and an older app.css) is in the PR; this pins the rule that produces it: token-based, both dimensions, in the file the panel links itself (so a tab
 * that kept an older app.css has it too), and no inline style in the module (the CSP does not allow it).
 */
const read = (file: string): string => readFileSync(new URL(`../src/ui/${file}`, import.meta.url), "utf8");
describe("the phone target of the Runtime CLI list's buttons", () => {
  const css = read("shared/runtime-install.css");
  const rule = /@media \(max-width: 899px\), \(pointer: coarse\) \{ \.runtime-cli-install-list li \.btn \{([^}]*)\} \}/.exec(css);
  it("is a scoped, token-based rule on the shared phone breakpoint, for height AND width", () => {
    expect(rule, "the rule").not.toBeNull();
    expect(rule![1]).toMatch(/min-height: var\(--tap, 44px\)/);
    expect(rule![1]).toMatch(/min-width: var\(--tap, 44px\)/);
    expect(read("shared/tokens.css")).toMatch(/--tap: 44px;/);
  });
  it("lives in runtime-install.css, which panel-runtimes.js links itself (an older app.css has no such rule), and the list's buttons are exactly the `.btn` the rule selects", () => {
    expect(read("panel-runtimes.js")).toContain('href", "/assets/runtime-install.css"');
    expect(read("runtime-cli-install.js")).toMatch(/<ul class="runtime-cli-install-list"/);
    expect(read("runtime-cli-install.js")).toMatch(/<li key=\$\{cli\.id\}[^]*?<button type="button" class="btn btn-sm"/);
  });
  it("uses no inline style (the page's CSP forbids it): neither the module nor the rule", () => {
    expect(read("runtime-cli-install.js")).not.toMatch(/\bstyle=/);
    expect(rule![0]).not.toMatch(/!important/);
  });
});
