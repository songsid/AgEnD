/**
 * M-3121: the model-picker smoke recorded `EvalError … 'unsafe-eval'` and a `script-src eval` violation on the chat page.
 * The page evaluated nothing: Playwright's `waitForFunction` evals a string expression in the page again on every poll
 * (a function is compiled once), and the dashboard's CSP has no 'unsafe-eval'. The fixture's `mounted()` passed a string,
 * and on a phone's chat page (no tab bar since phone v2) it polled more than once. The browser smokes and their fixture
 * pass functions; the CSP stays as it is.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(process.cwd(), "scripts/manual");
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? files(p) : /\.m?ts$/.test(n) ? [p] : []; });
}

describe("M-3121: browser waits never hand the page a string to eval", () => {
  it("no waitForFunction with a string expression under scripts/manual", () => {
    const hits = files(ROOT).flatMap((f) => readFileSync(f, "utf8").split("\n").map((l, i) => [f.slice(ROOT.length + 1) + ":" + (i + 1), l] as const)
      .filter(([, l]) => /waitForFunction\(\s*[`"']/.test(l)).map(([at]) => at));
    expect(hits).toEqual([]);
  });

  it("mounted() waits with a function, counts a phone chat's ‹ as navigation, and refuses a selector for its timeout", () => {
    const src = readFileSync(join(ROOT, "smoke-fixture/from-defaults.mts"), "utf8");
    expect(src).toContain('page.waitForFunction(() => [...document.querySelectorAll("#app .sidebar, #app .tabs, #app .sb-back")]');
    expect(src).toContain('if (typeof timeoutMs !== "number") throw Error(');
    expect(readFileSync(join(ROOT, "smoke/smoke-3500-model-picker.mts"), "utf8")).not.toMatch(/mounted\(page, "/);
  });
});
