/**
 * Every stylesheet the app ships is well formed: its blocks close. A block left open does not fail in the browser — it
 * swallows the rest of the file (v2.3.0-beta.20: the global search's phone-only `@media (max-width: 899px)` lost its
 * `}` in a merge, so the task board's styles below it applied on phones only, and the board on a desk had none).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const UI = join(process.cwd(), "src", "ui");
function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "vendor" ? [] : cssFiles(path);
    return name.endsWith(".css") ? [path] : [];
  });
}
/** The first place a block is closed that was never opened, or the line of the last block left open; null when balanced. */
function unbalanced(css: string): string | null {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " ")).replace(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g, (q) => " ".repeat(q.length));
  const open: number[] = [];
  let line = 1;
  for (const ch of text) {
    if (ch === "\n") line++;
    else if (ch === "{") open.push(line);
    else if (ch === "}" && !open.pop()) return `a } with no block to close at line ${line}`;
  }
  return open.length ? `a block opened at line ${open.at(-1)} never closes` : null;
}

describe("the app's stylesheets close every block", () => {
  const files = cssFiles(UI);
  it("finds them", () => { expect(files.length).toBeGreaterThan(1); });
  it.each(files.map((f) => [f.slice(UI.length + 1), f]))("%s", (_name, file) => {
    expect(unbalanced(readFileSync(file, "utf8"))).toBeNull();
  });
  it("the check sees an unclosed @media (a control)", () => {
    expect(unbalanced("@media (max-width: 899px) {\n  .a { color: red; }\n.b { color: blue; }\n")).toBe("a block opened at line 1 never closes");
  });
});
