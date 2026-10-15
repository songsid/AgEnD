/**
 * #1629 r4-6: the `web-appearance` skill and the what's-new entries. The skill must not drift from the code: every tool
 * it names exists, its slots, sizes, limits and contrast numbers are the code's. The 2.3 entries reach an instance once,
 * on 2.3 — never on a 2.2.x.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TOOLS } from "../src/channel/mcp-tools.js";
import { THEME_ASSET_LIMITS, THEME_ASSET_SLOTS } from "../src/web-theme-store.js";
import { APPEARANCE_DEFAULTS } from "../src/web-appearance-limits.js";
import { APPEARANCE_LIMITS } from "../src/web-appearance-policy.js";
import { CONTRAST_PAIRS, TAGLINE_MAX_GRAPHEMES, BIO_MAX_GRAPHEMES, BIO_MAX_BREAKS } from "../src/web-theme.js";
import { AGENT_WHATS_NEW, compareVersions, planWhatsNew } from "../src/agent-whats-new.js";
import { PREVIEW_FILE as VIEW_PREVIEW_FILE } from "../src/web-appearance-view.js";
import { PREVIEW_FILE as PARTS_PREVIEW_FILE } from "../src/web-asset-parts.js";

const SKILL = readFileSync(join(process.cwd(), "src/general-knowledge/skills/web-appearance/SKILL.md"), "utf8");

describe("the web-appearance skill", () => {
  it("names only real tools, and every appearance tool", () => {
    const names = new Set(TOOLS.map((t: { name: string }) => t.name));
    const named = [...SKILL.matchAll(/`([a-z_]+)`/g)].map(m => m[1]!).filter(n => /^(get|set|reset|preview)_/.test(n));
    expect(named.filter(n => !names.has(n))).toEqual([]);
    for (const t of ["get_web_theme", "set_web_theme", "set_web_theme_asset", "reset_web_theme", "get_web_appearance", "preview_web_appearance"]) expect(SKILL, t).toContain(`\`${t}\``);
  });
  it("its numbers are the code's: slots, sizes, rate limits, text limits, contrast", () => {
    for (const slot of THEME_ASSET_SLOTS) expect(SKILL, slot).toContain(`| \`${slot}\` |`);
    expect(SKILL).toContain(`| \`background\` | png, jpeg, webp, gif | ${THEME_ASSET_LIMITS.background.maxBytes / 1024} KiB, ${THEME_ASSET_LIMITS.background.maxSide} px a side |`);
    expect(SKILL).toContain(`| \`avatar\` | png, jpeg, webp, gif | ${THEME_ASSET_LIMITS.avatar.maxBytes / 1024} KiB, ${THEME_ASSET_LIMITS.avatar.maxSide} px a side |`);
    expect(SKILL).toContain(`default ${APPEARANCE_DEFAULTS.portrait.max_width}×${APPEARANCE_DEFAULTS.portrait.max_height}, ${APPEARANCE_DEFAULTS.portrait.max_kib / 1024} MiB`);
    expect(SKILL).toContain(`default ${APPEARANCE_DEFAULTS.banner.max_width}×${APPEARANCE_DEFAULTS.banner.max_height}, ${APPEARANCE_DEFAULTS.banner.max_kib} KiB`);
    expect(SKILL).toContain(`**${APPEARANCE_LIMITS.changeGapMs / 1000} s** between changes, at most **${APPEARANCE_LIMITS.changesPerHour} changes an hour**, at most **${APPEARANCE_LIMITS.uploadsPerHour} picture uploads an hour**`);
    expect(SKILL).toContain(`\`card.tagline\` (one line, 1..${TAGLINE_MAX_GRAPHEMES} characters), \`card.bio\` (1..${BIO_MAX_GRAPHEMES} characters, at most ${BIO_MAX_BREAKS} line breaks)`);
    const pairs = (fg: string) => CONTRAST_PAIRS.filter(([f]) => f === fg);
    expect(pairs("text").map(([, b, r]) => [b, r])).toEqual([["bg", 4.5], ["surface", 4.5], ["agentBubble", 4.5], ["userBubble", 4.5]]);
    expect(pairs("text2").map(([, b]) => b)).toEqual(["bg", "surface"]);
    expect(pairs("accent")).toEqual([["accent", "bg", 3]]);
    expect(SKILL).toContain("`text` at least 4.5:1 on `bg`, `surface` and both bubbles");
    expect(SKILL).toContain("`text2` at least 4.5:1 on `bg` and `surface`; `accent` at least 3:1 on `bg`");
  });
});

describe("what's new for 2.3 (#1633)", () => {
  it("the card notice shows the call that works: card inside set (#1891 review)", async () => {
    const text = AGENT_WHATS_NEW.find(e => e.id === "2.3-web-card")!.text;
    expect(text).toContain("`set_web_theme({ set: { card: { tagline, bio, portrait, banner } } })`");
    const { ThemeStore } = await import("../src/web-theme-store.js");
    const { WebAppearance } = await import("../src/web-appearance.js");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "agend-wn-card-"));
    try {
      const svc = new WebAppearance(new ThemeStore(dir), () => null);
      expect(svc.handleTool("a", "set_web_theme", { card: { tagline: "Hello" } })).toMatchObject({ errors: [{ path: "card" }] });       // not a top-level argument
      expect(svc.handleTool("a", "set_web_theme", { set: { card: { tagline: "Hello" } } })).toMatchObject({ theme: { card: { tagline: "Hello" } } });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  const OLD = AGENT_WHATS_NEW.filter(e => compareVersions(e.since, "2.2.0")! <= 0).map(e => e.id);
  it("an instance told everything of 2.2 hears the three 2.3 entries once on 2.3 — never on a 2.2.x", () => {
    expect(planWhatsNew({ record: { announced: OLD }, fresh: false, version: "2.2.5" })).toBeNull();
    for (const version of ["2.3.0-alpha.1", "2.3.0-beta.1", "2.3.0"]) {
      const plan = planWhatsNew({ record: { announced: OLD }, fresh: false, version });
      expect(plan && "ids" in plan ? plan.ids : plan, version).toEqual(["2.3-web-theme", "2.3-web-card", "2.3-web-appearance"]);
    }
    const all = AGENT_WHATS_NEW.map(e => e.id);
    expect(planWhatsNew({ record: { announced: all }, fresh: false, version: "2.3.0" })).toBeNull();
  });
});

describe("one preview file rule in two places (#1890 review)", () => {
  it("web-appearance-view's and web-asset-parts' PREVIEW_FILE are the same (the second keeps agend-agent small)", () => {
    expect(PARTS_PREVIEW_FILE.source).toBe(VIEW_PREVIEW_FILE.source);
    expect(PARTS_PREVIEW_FILE.flags).toBe(VIEW_PREVIEW_FILE.flags);
  });
});
