import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { IDENTITY_PALETTE, AUTO_PALETTE } from "../src/web-identity-color.js";
import { contrastRatio } from "../src/web-theme.js";
const css = readFileSync(new URL("../src/ui/shared/tokens.css", import.meta.url), "utf8");
const app = readFileSync(new URL("../src/ui/shared/app.css", import.meta.url), "utf8");
const values = (mode: string) => Object.fromEntries([...new RegExp(`\\.theme-swatch\\[data-palette="meadow"\\]\\[data-tone="${mode}"\\]\\s*\\{([^{}]*)\\}`).exec(css)![1]!.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(x => [x[1]!, x[2]!.trim()]));
function apca(text: string, bg: string): number {
  const y = (hex: string) => { const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255); const v = 0.2126729 * c[0]! ** 2.4 + 0.7151522 * c[1]! ** 2.4 + 0.072175 * c[2]! ** 2.4; return v < 0.022 ? v + (0.022 - v) ** 1.414 : v; };
  const t = y(text), b = y(bg); if (Math.abs(b - t) < 0.0005) return 0;
  if (b > t) { const s = (b ** 0.56 - t ** 0.57) * 1.14; return s < 0.1 ? 0 : (s - 0.027) * 100; }
  const s = (b ** 0.65 - t ** 0.62) * 1.14; return s > -0.1 ? 0 : (s + 0.027) * 100;
}
const mix = (a: string, b: string, alpha: number) => "#" + [1, 3, 5].map(i => Math.round(parseInt(a.slice(i, i + 2), 16) * (1 - alpha) + parseInt(b.slice(i, i + 2), 16) * alpha).toString(16).padStart(2, "0")).join("");
const tile = (p: Record<string,string>) => decodeURIComponent(/url\("data:image\/svg\+xml,([^";]+)"\)/.exec(p["meadow-wallpaper-tile"]!)![1]!);
describe("M3377 original static Meadow wallpaper", () => {
  for (const mode of ["light", "dark"] as const) {
    it(`${mode}: a tiny original leaf tile and two gradient stops`, () => {
      const p = values(mode);
      expect(typeof p["meadow-wallpaper-tile"]).toBe("string");
      const svg = tile(p); expect(svg.length).toBeLessThan(1000);
      expect(svg).toContain('viewBox="0 0 192 192"');
      expect(svg).toContain('<path'); expect(svg).toContain('fill="none"');
      expect(svg).not.toMatch(/script|foreignObject|<image|href=|<animate|<filter/i);
      expect(p["meadow-wallpaper-start"]).toMatch(/^#[0-9a-f]{6}$/);
      expect(p["meadow-wallpaper-end"]).not.toBe(p["meadow-wallpaper-start"]);
    });
    it(`${mode}: text and opaque names/bubbles keep AA at the worst tile coverage`, () => {
      const p = values(mode); expect(typeof p["meadow-wallpaper-tile"]).toBe("string");
      const svg = tile(p), alpha = Number(/<g opacity="([.0-9]+)"/.exec(svg)![1]);
      expect(alpha).toBeGreaterThan(0); expect(alpha).toBeLessThanOrEqual(.035);
      const ink = /stroke="(#[0-9a-f]{6})"/.exec(svg)![1]!;
      for (const stop of [p["meadow-wallpaper-start"]!, p["meadow-wallpaper-end"]!]) for (const bg of [stop, mix(stop, ink, alpha)]) {
        for (const key of ["text", "palette-chat-text-2", "palette-chat-text-3", "accent"]) expect(contrastRatio(p[key]!, bg), `${key} on ${bg}`).toBeGreaterThanOrEqual(4.5);
        if (mode === "dark") for (const key of ["palette-chat-text-2", "palette-chat-text-3"]) expect(Math.abs(apca(p[key]!, bg))).toBeGreaterThanOrEqual(60);
      }
      for (const identity of [...IDENTITY_PALETTE, ...AUTO_PALETTE]) expect(contrastRatio(identity[mode], p.surface!), identity.id).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(p.text!, p["user-bubble"]!)).toBeGreaterThanOrEqual(4.5);
    });
  }
  it("paints the stationary panel, and leaves explicit agent backgrounds in charge", () => {
    const rules = [...app.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(x => /meadow-wallpaper/.test(x[2]!));
    expect(rules).toHaveLength(1);
    expect(rules[0]![1]!.trim()).toBe(':root[data-palette="meadow"] .shell:not(.th-page) .p-chat:not([style*="--bg:"])');
    expect(rules[0]![2]).toContain('linear-gradient(');
    expect(rules[0]![2]).toContain('background-size: 192px 192px, 100% 100%');
    expect(rules[0]![2]).not.toMatch(/animation|transition|filter|background-attachment:\s*(fixed|local)|will-change/);
  });
  it("yields every Meadow chat treatment to a shell page theme", () => {
    const selectors = [...app.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{[^{}]*\}/g)].map(x => x[1]!.trim()).filter(x => x.startsWith(':root[data-palette="meadow"]') && x.includes('.p-chat'));
    expect(selectors.length).toBeGreaterThanOrEqual(2);
    for (const selector of selectors) expect(selector).toContain('.shell:not(.th-page) .p-chat');
  });
  it("keeps every token outside Meadow byte-identical to the dev base", () => {
    const rest = css.replace(/((?::root\[data-palette="meadow"\]|\.theme-swatch\[data-palette="meadow"\])[^{}]*\{)[^{}]*(\})/g, (_all, start, end) => start + end);
    expect(createHash("sha256").update(rest).digest("hex")).toBe("d14eaffe253982a8344c38a85adebedb83080180af2ab734d67a50550826b7fa");
  });
});
