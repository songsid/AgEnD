// M-3455: dragging the split view's divider re-styled and re-laid-out both long chat histories every frame.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../src/ui/shared/app.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const rules = (selector: string) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(m => m[1].split(",").map(s => s.trim()).includes(selector)).map(m => m[2]);

describe("split view divider drag (M-3455)", () => {
  it("the sizes written each frame are not inherited, so a drag restyles only the element that reads them", () => {
    for (const name of ["--ws-first", "--thread-snap"]) {
      const at = new RegExp(`@property ${name} \\{([^}]*)\\}`).exec(css);
      expect(at, name).not.toBeNull();
      expect(at![1]).toMatch(/inherits:\s*false/); expect(at![1]).toMatch(/syntax:\s*"\*"/);   // "*": no initial value, var() fallbacks still apply
    }
    // Each is read only by the element it is written on (the grid; the thread list), never by a descendant.
    expect([...css.matchAll(/var\(--ws-first\b/g)]).toHaveLength(2);
    expect(css).toMatch(/\.ws-geometry\.ws-right \{ grid-template-columns: var\(--ws-first,/);
    expect(css).toMatch(/\.ws-geometry\.ws-stack \{[^}]*grid-template-rows: var\(--ws-first,/);
    expect([...css.matchAll(/var\(--thread-snap\b/g)]).toHaveLength(1);
    expect(css).toMatch(/\.thread \{ max-width: var\(--col\); margin: var\(--thread-snap, 0px\)/);
  });
  it("off-screen rows are skipped only while the divider is dragged, at their last drawn size", () => {
    expect(rules(".thread > .msg").join(";")).toMatch(/contain-intrinsic-size:\s*auto 96px/);
    expect(rules(".ws-resizing .thread > .msg").join(";")).toMatch(/content-visibility:\s*auto/);
    // Normal reading never skips rows: content-visibility appears nowhere else.
    expect([...css.matchAll(/content-visibility:/g)]).toHaveLength(1);
  });
});
