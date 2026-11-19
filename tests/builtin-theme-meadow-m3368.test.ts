import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { IDENTITY_PALETTE, AUTO_PALETTE } from "../src/web-identity-color.js";
import { contrastRatio } from "../src/web-theme.js";
const css = readFileSync(new URL("../src/ui/shared/tokens.css", import.meta.url), "utf8");
const app = readFileSync(new URL("../src/ui/shared/app.css", import.meta.url), "utf8");
const body = (name: string, mode: string) => new RegExp(`\\.theme-swatch\\[data-palette="${name}"\\]\\[data-tone="${mode}"\\]\\s*\\{([^{}]*)\\}`).exec(css)![1]!;
const tokens = (mode: string) => Object.fromEntries([...body("meadow", mode).matchAll(/--([\w-]+):\s*([^;]+);/g)].map(m => [m[1]!, m[2]!.trim()]));
describe("M3368 Meadow reference and isolation", () => {
  it("keeps the light chrome white and the sage limited to the chat", () => {
    const p = tokens("light");
    expect([p.bg, p["bg-sidebar"], p.surface, p["surface-2"], p["palette-chat-bg"]]).toEqual(["#ffffff", "#ffffff", "#ffffff", "#f4f4f5", "#c4cf93"]);
    expect(p["accent-decoration"]).toBe("#4fae4e");
  });
  for (const mode of ["light", "dark"] as const) it(`${mode}: names and chat metadata keep AA`, () => {
    const p = tokens(mode);
    expect(typeof p["palette-chat-bg"]).toBe("string");
    for (const x of [...IDENTITY_PALETTE, ...AUTO_PALETTE]) expect(contrastRatio(x[mode], p.surface!), x.id).toBeGreaterThanOrEqual(4.5);
    for (const x of [p.text!, p["palette-chat-text-2"]!, p["palette-chat-text-3"]!, p.accent!]) expect(contrastRatio(x, p["palette-chat-bg"]!)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(p["on-accent"]!, p["accent-fill"]!)).toBeGreaterThanOrEqual(4.5);
  });
  it("scopes every chat adaptation to Meadow without overriding inline agent styles", () => {
    const rules = [...app.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(m => /palette-chat-|accent-decoration/.test(m[2]!));
    expect(rules.length).toBeGreaterThan(0);
    for (const r of rules) for (const selector of r[1]!.trim().split(",")) expect(selector.trim()).toMatch(/^(?::root\[data-palette="meadow"\]|\.theme-swatch\[data-palette="meadow"\])/ );
    expect(rules.map(x => x[2]).join(" ")).not.toContain("!important");
    const meta = /:root\[data-palette="meadow"\] \.shell:not\(\.th-page\) \.p-chat \.msg \.meta\s*\{([^{}]*)\}/.exec(app)![1]!;
    expect(meta).toMatch(/background:\s*var\(--surface\)/);
  });
  it("preserves all six other palette declarations byte for byte after the light-sidebar fix", () => {
    const expected: Record<string,string> = {
  "sky/light": "6c5fec789b857e48b4c89cc4046c868876376acdc8a16aa83c3c7114927bb896",
  "sky/dark": "45276d6a47d11d61d341ebd50c105e5054d5fee88cce478846167eb8dfe07e31",
  "violet/light": "a41462c040e0e2ea890eba895263859ff9da2cde89acd4db327be9d9969d518d",
  "violet/dark": "c1443e068c5f7d6346055b14ef6a63a3c5a09265e876616127c63ef8ab66f729",
  "mint/light": "e0c2f458475044d0d4ce60fcb0a1c54ab807aaa70442ffe0e29ac0f9fe7ff3bf",
  "mint/dark": "b871f145633a2ba578ed684a3c78109a8ed027f05e1bb246e0a56b0fd178543d"
};
    for (const [key, hash] of Object.entries(expected)) { const [name, mode] = key.split("/"); expect(createHash("sha256").update(body(name!, mode!)).digest("hex"), key).toBe(hash); }
  });
});
