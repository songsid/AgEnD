/**
 * M-3842: disabled buttons stay readable. The capture checks on #4497 found them nearly unreadable on dark (opacity 0.45).
 * The shared `.btn:disabled` now draws off buttons with muted text (`--text-3` mixed 75% into `--bg`), no fill and a dashed
 * edge. This checks the rule's shape, and that its text reaches 3:1 on the page (`--bg`) and on a card (`--surface`) in
 * every theme block and palette tokens.css defines.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SHARED = join(process.cwd(), "src", "ui", "shared");
const TOKENS = readFileSync(join(SHARED, "tokens.css"), "utf8");
const APP = readFileSync(join(SHARED, "app.css"), "utf8");

const hex = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const lum = (rgb: number[]) => { const c = rgb.map(v => v / 255).map(x => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!; };
const contrast = (a: number[], b: number[]) => { const [x, y] = [lum(a), lum(b)]; return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
/** color-mix(in srgb, a 75%, b): the off button's text. */
const mix = (a: number[], b: number[], p = 0.75) => a.map((v, i) => v * p + b[i]! * (1 - p));

/** Every block in tokens.css that sets --text-3, --bg and --surface as #rrggbb. */
function themes(): Array<{ name: string; t: Record<string, string> }> {
  const out: Array<{ name: string; t: Record<string, string> }> = [];
  for (const m of TOKENS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const t = Object.fromEntries([...m[2]!.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map(x => [x[1]!, x[2]!]));
    if (t["text-3"] && t["text-2"] && t.bg && t.surface) out.push({ name: m[1]!.trim().replace(/\s+/g, " ").slice(0, 80), t });
  }
  return out;
}

describe("M-3842: disabled buttons", () => {
  it("one shared rule: no opacity; muted text from the theme, no fill, a dashed edge; a ghost button keeps no edge", () => {
    const rule = APP.match(/\n\.btn:disabled \{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toContain("opacity: 1");
    expect(rule).toContain("color: color-mix(in srgb, var(--text-3) 75%, var(--bg))");
    expect(rule).toContain("background: transparent");
    expect(rule).toContain("border-style: dashed");
    expect(APP).toMatch(/\n\.btn-ghost:disabled \{ border-color: transparent; \}/);
    expect(APP).toMatch(/\n\.btn-send:disabled \{ background: var\(--surface-2\); color: var\(--text-3\); border-color: transparent; border-style: solid; \}/);
    expect(APP).not.toMatch(/\.btn(-[a-z]+)?:disabled \{[^}]*opacity: 0\./);           // no button faded by opacity
    expect(APP).not.toContain(".contact-grant-dialog .btn-primary:disabled");           // no per-page override left
    // No rule fades an off button that carries .btn: the chat's reply and poll buttons (.rb-btn) included (#4576 review).
    for (const m of APP.matchAll(/([^{}]*\.rb-btn[^{}]*:disabled[^{}]*)\{([^}]*)\}/g)) expect(m[2], m[1]!.trim()).not.toMatch(/opacity:\s*0?\.\d/);
    expect(APP).toMatch(/\.rb-btn\.chosen, \.rb-btn\.chosen:disabled \{[^}]*border-style: solid;/);          // the chosen answer keeps its solid green edge
    expect(APP).toMatch(/\n\.rb-row\.poll \.rb-btn:disabled:not\(\.chosen\) \{ color: var\(--text-2\); \}/);   // a closed poll's tallies stay readable
  });
  it("its text reaches 3:1 on the page and on a card, in every theme and palette", () => {
    const all = themes();
    expect(all.length).toBeGreaterThanOrEqual(10);                                        // dark, light ×2, four palettes × tones
    for (const { name, t } of all) {
      const off = mix(hex(t["text-3"]!), hex(t.bg!));
      expect(contrast(off, hex(t.bg!)), `${name} on --bg`).toBeGreaterThanOrEqual(3);
      expect(contrast(off, hex(t.surface!)), `${name} on --surface`).toBeGreaterThanOrEqual(3);
      // a closed poll's choices (--text-2, nothing faded) on the page and a card
      expect(contrast(hex(t["text-2"]!), hex(t.bg!)), `${name} poll on --bg`).toBeGreaterThanOrEqual(3);
      expect(contrast(hex(t["text-2"]!), hex(t.surface!)), `${name} poll on --surface`).toBeGreaterThanOrEqual(3);
      if (t["surface-2"]) expect(contrast(hex(t["text-3"]!), hex(t["surface-2"]!)), `${name} Send's icon on --surface-2`).toBeGreaterThanOrEqual(3);
    }
  });
  it("the style guide states the rule", () => {
    const guide = readFileSync(join(process.cwd(), "docs", "design", "ui-style-guide.md"), "utf8");
    expect(guide).toContain("**Disabled controls** (M-3842)");
    expect(guide).toContain("at least 3:1 against the page and a card");
  });
});
