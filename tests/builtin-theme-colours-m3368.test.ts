import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkTheme, contrastRatio } from "../src/web-theme.js";

const css = readFileSync(new URL("../src/ui/shared/tokens.css", import.meta.url), "utf8");
const names = ["sky", "meadow", "violet", "mint"];
const declarations = (body: string) => Object.fromEntries([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(m => [m[1]!, m[2]!.trim()]));
const base = (mode: string) => declarations(new RegExp(mode === "light" ? ':root\\[data-theme="light"\\]\\s*\\{([^{}]*)\\}' : '\\n:root\\s*\\{([^{}]*)\\}').exec(css)![1]!);
const palette = (name: string, mode: string) => ({ ...base(mode), ...declarations(new RegExp(`\\.theme-swatch\\[data-palette="${name}"\\]\\[data-tone="${mode}"\\]\\s*\\{([^{}]*)\\}`).exec(css)![1]!) });
// The same APCA-W3 0.0.98G-4g check as web-tokens-1408: dark secondary text must remain readable on a phone.
function apca(text: string, bg: string): number {
  const y = (hex: string) => { const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255); const v = 0.2126729 * c[0]! ** 2.4 + 0.7151522 * c[1]! ** 2.4 + 0.072175 * c[2]! ** 2.4; return v < 0.022 ? v + (0.022 - v) ** 1.414 : v; };
  const t = y(text), b = y(bg); if (Math.abs(b - t) < 0.0005) return 0;
  if (b > t) { const s = (b ** 0.56 - t ** 0.57) * 1.14; return s < 0.1 ? 0 : (s - 0.027) * 100; }
  const s = (b ** 0.65 - t ** 0.62) * 1.14; return s > -0.1 ? 0 : (s + 0.027) * 100;
}
const tint = (fg: string, bg: string, amount: number) => `#${[1, 3, 5].map(i => Math.round(parseInt(fg.slice(i, i + 2), 16) * amount + parseInt(bg.slice(i, i + 2), 16) * (1 - amount)).toString(16).padStart(2, "0")).join("")}`;

describe("M3368 every built-in palette in both appearances", () => {
  for (const name of names) for (const mode of ["light", "dark"]) {
    it(`${name}/${mode}: passes the existing theme validator and full AA token pairs`, () => {
      const p = palette(name, mode);
      const patch = { bg: p.bg, surface: p.surface, text: p.text, text2: p["text-2"], accent: p.accent, userBubble: p["user-bubble"] };
      expect(checkTheme({ v: 1, colors: { [mode]: patch }, page: { on: true, sidebar: { [mode]: p["bg-sidebar"] } } }, { assets: new Set() })).toMatchObject({ ok: true });
      const textPairs = [
        ...["text", "text-2", "text-3", "accent", "ok", "warn", "danger"].flatMap(t => ["bg", "bg-sidebar", "surface"].map(b => [t, b])),
        ...["text", "text-2", "text-3"].map(t => [t, "surface-2"]), ["text", "user-bubble"], ["on-accent", "accent-fill"], ["on-danger", "danger-fill"],
        ...["text", "tk-k", "tk-s", "tk-n", "tk-c"].map(t => [t, "code-bg"]), ["text", "code-head"], ["text-2", "code-head"], ["text", "inline-code"],
      ];
      for (const [t, b] of textPairs) expect(contrastRatio(p[t!]!, p[b!]!), `${t}/${b}`).toBeGreaterThanOrEqual(4.5);
      for (const t of ["focus", "border-strong"]) for (const b of ["bg", "bg-sidebar", "surface"]) expect(contrastRatio(p[t]!, p[b]!), `${t}/${b}`).toBeGreaterThanOrEqual(3);
      for (const b of ["bg", "bg-sidebar", "surface"]) expect(contrastRatio(p["text-3"]!, tint(p.accent!, p[b]!, mode === "dark" ? 0.14 : 0.08)), `metadata on tinted ${b}`).toBeGreaterThanOrEqual(4.5);
      if (p["palette-chat-bg"] && mode === "dark") for (const t of ["palette-chat-text-2", "palette-chat-text-3"]) expect(Math.abs(apca(p[t]!, p["palette-chat-bg"]!)), `${t}/chat APCA`).toBeGreaterThanOrEqual(60);
      if (mode === "dark") for (const t of ["text-2", "text-3"]) for (const b of ["bg", "bg-sidebar", "surface"]) expect(Math.abs(apca(p[t]!, p[b]!)), `${t}/${b} APCA`).toBeGreaterThanOrEqual(60);
    });
  }
});
