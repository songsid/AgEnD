/**
 * #1611 (baseline: the issue body): on a touch screen or the phone layout no text field is under 16px — iOS Safari
 * zooms the page in on focusing one, and never zooms back. One shared rule in tokens.css (loaded by the app and the
 * sign-in page) makes the small type sizes 16px on the controls themselves; pinch zoom is never disabled; the desktop
 * sizes are untouched. What a browser computes on every page is the smoke in the PR; here the rule, its reach, and
 * that no control escapes it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const UI = join(process.cwd(), "src", "ui");
const read = (p: string) => readFileSync(join(UI, p), "utf8");
const noComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

describe("#1611: text fields are never under 16px on a phone", () => {
  it("tokens.css: on a coarse pointer or the phone layout, the small type sizes are 16px on input, select and textarea", () => {
    const css = noComments(read("shared/tokens.css"));
    const m = /@media \(pointer: coarse\), \(max-width: 899px\) \{\s*input, select, textarea \{([^}]*)\}\s*\}/.exec(css);
    expect(m, "the shared rule").not.toBeNull();
    const decl = Object.fromEntries([...m![1]!.matchAll(/(--fs-[a-z]+):\s*(\d+)px/g)].map(x => [x[1], Number(x[2])]));
    expect(decl).toEqual({ "--fs-xs": 16, "--fs-sm": 16, "--fs-md": 16 });
  });
  it("every page with text fields loads it, and none disables pinch zoom", () => {
    for (const page of ["app.html", "signin.html"]) {
      const html = read(page);
      expect(html, page).toContain('<link rel="stylesheet" href="/assets/tokens.css">');
      const vp = /<meta name="viewport" content="([^"]*)">/.exec(html)![1]!;
      expect([page, /maximum-scale|user-scalable/.test(vp)]).toEqual([page, false]);
    }
  });
  it("no control escapes the rule: every font size set on a field is a small token, inherited, or already ≥16px", () => {
    const sources = { "app.css": noComments(read("shared/app.css")), "signin.html": read("signin.html") };
    const offenders: string[] = [];
    for (const [name, css] of Object.entries(sources)) {
      for (const m of css.matchAll(/([^{}]*\b(?:input|select|textarea)\b[^{}]*)\{([^}]*)\}/g)) {
        const size = /font(?:-size)?:\s*([^;]+)/.exec(m[2]!)?.[1]?.trim();
        if (!size) continue;
        // #1615: `inherit` is no pass — an inherited size is the container's; only the reset may say it, and the floor
        // below it (next test) is what keeps a field that has no size of its own at 16px.
        const reset = name === "app.css" && m[1]!.trim() === "button, input, select, textarea";
        const ok = reset || /var\(--fs-(?:xs|sm|md)\)/.test(size) || /^max\(16px, 1em\)$/.test(size)
          || ([...size.matchAll(/(\d+(?:\.\d+)?)px/g)].every(x => Number(x[1]) >= 16) && /\dpx/.test(size));
        if (!ok) offenders.push(`${name}: ${m[1]!.trim()} → ${size}`);
      }
    }
    expect(offenders).toEqual([]);
  });
  it("#1615: a field with no size of its own has a 16px floor on a phone — after the reset, as weak as it, keeping a larger one", () => {
    const css = noComments(read("shared/app.css"));
    const reset = css.indexOf("button, input, select, textarea { font: inherit; color: inherit; }");
    const floor = css.indexOf("@media (pointer: coarse), (max-width: 899px) { input, select, textarea { font-size: max(16px, 1em); } }");
    expect([reset >= 0, floor > reset]).toEqual([true, true]);
  });

  it("the composer has no rule of its own any more — the shared one sizes it", () => {
    expect(noComments(read("shared/app.css"))).not.toMatch(/\.composer textarea \{ font-size: 16px; \}/);
  });
});
