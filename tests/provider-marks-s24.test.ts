/**
 * S-24 (the user, hmsg-d0ee3254 / hmsg-d0747eb3): provider marks follow the open-source norm — clean, unmodified SVG marks
 * from their owners or a permissive icon set, with a notice; a generic tile per provider and one switch for a takedown.
 *  - Grok: a vector mark from @lobehub/icons (MIT), no App Store JPEG; OpenCode and Muse now have marks (same set);
 *  - Antigravity: the press kit's full-colour icon; Claude / OpenAI / Kiro / Anthropic as before;
 *  - complete SVGs are bundled byte for byte (base64) as isolated images; single-colour marks draw in the text colour;
 *  - the switch: every mark off, or one provider withheld → its generic two-letter tile (no third-party artwork);
 *  - THIRD_PARTY_NOTICES and the README say whose marks they are, where each came from, and its licence.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { page, h, type AppPage } from "./helpers/app-harness.js";

let p: AppPage, M: any, C: any;
beforeAll(async () => {
  p = page({ url: "http://localhost/ui", storage: { agend_lang: "en" } });
  M = await import("/ui/js/provider-marks.js" as string);
  C = await import("/ui/js/cli-picker.js" as string);
});
afterEach(async () => { await p.unmount(); M.MARK_SWITCH.brandMarks = true; M.MARK_SWITCH.withheld.clear(); });
afterAll(() => p.restore());
const SRC = readFileSync(join(process.cwd(), "src", "ui", "provider-marks.js"), "utf8");
const draw = async (provider: string) => { await p.mount(h(M.ProviderMark, { provider, size: 20 })); return p.root.firstElementChild as any; };
const decoded = (el: any) => Buffer.from(String(el.getAttribute("src")).replace(/^data:image\/svg\+xml;base64,/, ""), "base64").toString("utf8");

describe("S-24 the marks", () => {
  it("every provider the CLI picker names has a mark: Grok, OpenCode and Muse too", async () => {
    for (const [cli, provider] of [["claude-code", "claude"], ["codex", "openai"], ["kiro-cli", "kiro"], ["antigravity", "antigravity"], ["grok", "grok"], ["opencode", "opencode"], ["muse", "muse"]]) {
      // The picker's mark is the provider's own mark (not the generic "code" glyph a CLI without one falls back to).
      await p.mount(h(M.ProviderMark, { provider, size: 20 }));
      const own = p.root.innerHTML;
      await p.unmount();
      await p.mount(h(C.CliProductMark, { id: cli }));
      const el = p.root.querySelector(`[data-cli="${cli}"]`);
      expect([!!el.querySelector("img, svg path, svg rect"), el.innerHTML], cli).toEqual([true, own]);
      expect(M.showsBrandMark(provider), provider).toBe(true);
      await p.unmount();
    }
  });
  it("Grok is a vector mark (no JPEG anywhere); Grok and OpenCode draw in the text colour (single-colour marks)", async () => {
    expect(SRC).not.toMatch(/image\/jpeg|image\/png|base64,\/9j/);
    for (const provider of ["grok", "opencode"]) {
      const svg = await draw(provider);
      expect([svg.tagName.toLowerCase(), svg.getAttribute("fill"), svg.getAttribute("fill-rule"), svg.querySelectorAll("path").length > 0], provider).toEqual(["svg", "currentColor", "evenodd", true]);
      await p.unmount();
    }
  });
  it("complete marks are isolated images, byte for byte as published: Antigravity's press-kit icon, Muse's colour mark, Kiro's icon", async () => {
    const ag = decoded(await draw("antigravity")); await p.unmount();
    const mu = decoded(await draw("muse")); await p.unmount();
    const ki = decoded(await draw("kiro"));
    expect([ag.startsWith('<svg width="180" height="180" viewBox="0 0 180 180"'), ag.includes('fill="#3186FF"'), ag.includes('style="mask-type:alpha"')]).toEqual([true, true, true]);
    expect([mu.includes("<title>Muse</title>"), mu.includes("<linearGradient")]).toEqual([true, true]);
    expect(ki.includes('fill="#9046FF"')).toBe(true);
  });
  it("Claude and OpenAI are as before (Claude's orange product mark)", async () => {
    const claude = await draw("claude");
    expect(claude.getAttribute("fill")).toBe("#D97757");
  });
});

describe("S-24 the takedown switch", () => {
  it("one provider withheld: its generic two-letter tile (no third-party artwork); the others keep theirs", async () => {
    M.MARK_SWITCH.withheld.add("grok");
    const grok = await draw("grok");
    expect([grok.getAttribute("class"), grok.querySelector("text").textContent, grok.querySelectorAll("path").length]).toEqual(["provider-tile", "Gk", 0]);
    await p.unmount();
    expect((await draw("opencode")).getAttribute("class")).not.toBe("provider-tile");
  });
  it("every mark off: each provider its tile (Mu, Oc, Ag, …)", async () => {
    M.MARK_SWITCH.brandMarks = false;
    const letters: string[] = [];
    for (const provider of Object.keys(M.TILES)) { letters.push((await draw(provider)).querySelector("text").textContent); await p.unmount(); }
    expect(letters).toEqual(Object.values(M.TILES));
    expect(letters).toEqual(expect.arrayContaining(["Mu", "Oc", "Gk", "Ag"]));
  });
  it("the switch is one line in the source", () => {
    expect(SRC).toContain("export const MARK_SWITCH = { brandMarks: true, withheld: new Set([]) };");
  });
});

describe("S-24 notices", () => {
  it("THIRD_PARTY_NOTICES names each mark's source and licence; it and the README say the marks are their owners' (no affiliation)", () => {
    const notices = readFileSync(join(process.cwd(), "THIRD_PARTY_NOTICES.md"), "utf8"), readme = readFileSync(join(process.cwd(), "README.md"), "utf8");
    for (const mark of ["Grok", "OpenCode", "Muse"]) expect(notices, mark).toMatch(new RegExp(`^\\| ${mark}[^\\n]*@lobehub/icons[^\\n]*\\| MIT \\|$`, "m"));
    expect(notices).toMatch(/MIT License\s+Copyright \(c\) 2023 LobeHub\s+Permission is hereby granted, free of charge/);
    for (const s of ["@lobehub/icons", "https://antigravity.google/press", "https://claude.com/icon.svg", "https://kiro.dev/icon.svg", "https://openai.com/brand/", "Grok", "OpenCode", "Muse"]) expect(notices, s).toContain(s);
    expect(notices).not.toContain("apps.apple.com");
    for (const text of [notices, readme]) expect(/belong to their respective owners/.test(text) && /no affiliation/i.test(text)).toBe(true);
  });
});
