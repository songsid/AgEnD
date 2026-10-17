/**
 * #1629 r4-6: the `web-appearance` skill and the what's-new entries. The skill must not drift from the code: every tool
 * it names exists, its slots, sizes, limits and contrast numbers are the code's. The 2.3 what's-new lines reach an
 * instance once, from 2.3.0-beta.2 — never on a 2.2.x — and only name the skill: the details are here.
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
import * as W from "../src/web-widget.js";

const SKILL = readFileSync(join(process.cwd(), "src/general-knowledge/skills/web-appearance/SKILL.md"), "utf8");

describe("the web-appearance skill", () => {
  it("Try click is sample-only consent with isolated chrome; the ordinary CSS policy remains", () => {
    const trial = SKILL.slice(SKILL.indexOf("### Try:"), SKILL.indexOf("### Static Chat"));
    expect(trial).toContain("no global HTML-preview opt-in"); expect(trial).toContain("closed Shadow DOM"); expect(trial).toContain("Custom CSS stays active elsewhere"); expect(trial).not.toContain("Custom CSS must be off");
    expect(SKILL).toContain("on, loading or unknown");
  });
  it("names only real tools, and every appearance tool", () => {
    const names = new Set(TOOLS.map((t: { name: string }) => t.name));
    const named = [...SKILL.matchAll(/`([a-z_]+)`/g)].map(m => m[1]!).filter(n => /^(get|set|reset|preview)_/.test(n));
    expect(named.filter(n => !names.has(n))).toEqual([]);
    for (const t of ["get_web_theme", "set_web_theme", "set_web_theme_asset", "reset_web_theme", "get_web_appearance", "preview_web_appearance", "set_web_widget", "remove_web_widget", "export_web_mod", "propose_web_mod"]) expect(SKILL, t).toContain(`\`${t}\``);
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
  it("its widget rules are the code's: slots, types, binds, sizes, the data budget (r4-4)", () => {
    expect(SKILL).toContain(`\`chat_header\` (a strip under your chat header: at most **${W.SLOT_RULES.chat_header.maxItems}** items, of ${W.SLOT_RULES.chat_header.types.map(t => `\`${t}\``).join(", ")})`);
    expect(SKILL).toContain(`\`details\` (a card on your Details page: at most **${W.SLOT_RULES.details.maxItems}** items, any type)`);
    for (const t of W.WIDGET_ITEM_TYPES) expect(SKILL, t).toContain(`| \`${t}\` |`);
    for (const tone of W.WIDGET_TONES) expect(SKILL, tone).toContain(`\`${tone}\``);
    for (const b of W.INSTANCE_BINDS) expect(SKILL, b).toContain(`\`${b}\``);
    expect(SKILL).toContain(`\`{ v: 1, title: 1..${W.WIDGET_TITLE_MAX} characters, items: [item, …] }\``);
    expect(SKILL).toContain(`| \`text\` | one line | 1..${W.WIDGET_TEXT_MAX} characters | |`);
    expect(SKILL).toContain(`| \`list\` | a short list | 1..${W.WIDGET_LIST_ITEMS} lines of 1..${W.WIDGET_LIST_TEXT_MAX} characters | |`);
    expect(SKILL).toContain(`| \`spark\` | a sparkline and its last number | 2..${W.WIDGET_SPARK_POINTS} numbers | |`);
    expect(SKILL).toContain(`The spec is at most ${W.WIDGET_SPEC_MAX_BYTES} bytes and the data at most ${W.WIDGET_DATA_MAX_BYTES}.`);
    expect(SKILL).toContain(`at least **${APPEARANCE_LIMITS.dataGapMs / 1000} s**\n  apart, at most **${APPEARANCE_LIMITS.dataPerHour} an hour**`);
    const example = JSON.parse(/```json\n(\{ "slot"[\s\S]*?)\n```/.exec(SKILL)![1]!);
    expect(W.checkWidgetSpec(example.spec, example.slot).ok, "the skill's example is a valid spec").toBe(true);
    expect(W.checkWidgetData(example.data, (W.checkWidgetSpec(example.spec, example.slot) as { value: any }).value).ok).toBe(true);
  });
});

describe("what's new for 2.3 (#1633, #2012: topic lines; the details are the skill's)", () => {
  const FLAT = SKILL.replace(/\s+/g, " ");
  it("the skill shows the card call that works: card inside set (#1891 review)", async () => {
    expect(FLAT).toContain("`set_web_theme({ set: { card: { tagline, bio, portrait, banner } } })`");
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
  it("one web-appearance topic line names the skill; every tool area it lists is in the skill", () => {
    const topic = AGENT_WHATS_NEW.find(e => e.id === "2.3-web-appearance-topic")!;
    expect(topic.since).toBe("2.3.0-beta.2");
    expect(topic.text).toContain("Load the `web-appearance` skill");
    for (const tool of topic.text.match(/`[a-z_]+`/g)!.map(t => t.slice(1, -1)).filter(t => t !== "web-appearance")) {
      expect(TOOLS.some(t => t.name === tool), tool).toBe(true);
      expect(SKILL, tool).toContain(`\`${tool}`);
    }
    expect(AGENT_WHATS_NEW.filter(e => e.id.startsWith("2.3-")).map(e => e.id)).toEqual(["2.3-web-appearance-topic", "2.3-web-settings-for-the-user", "2.3-repo-tools"]);
  });
  it("#2056: General's topic line names the skill and its two tools, from beta.3; the skill reaches General too", () => {
    const line = AGENT_WHATS_NEW.find(e => e.id === "2.3-web-settings-for-the-user")!;
    expect([line.since, line.text.includes("Load the `web-appearance` skill")]).toEqual(["2.3.0-beta.3", true]);
    for (const tool of ["get_web_settings", "set_web_settings"]) { expect(line.text).toContain(`\`${tool}\``); expect(SKILL).toContain(`\`${tool}`); expect(TOOLS.some(t => t.name === tool)).toBe(true); }
    expect(SKILL).toMatch(/^roles: \[general, worker\]$/m);
  });
  it("what the six folded 2.3.0-alpha.1 entries said is in the skill", () => {
    const facts = [
      // web-theme
      "`set_web_theme { set?, clear? }`", "`workingLabel`", "`reset_web_theme`", "`set_web_theme_asset { slot, file }`", "At least **30 s** between changes, at most **10 changes an hour**", "refused with `locked`",
      // web-card
      "`card.tagline`", "`card.bio`", "`card.portrait`", "A person may set their own version of any field",
      // web-appearance
      "`get_web_appearance`", "`preview_web_appearance` (`modes`", "`.agend/appearance/<mode>.svg`",
      // web-mod
      "`export_web_mod { name, version, title? }`", "`propose_web_mod { file }`", "Settings → Web appearance → Mods", "**You never import**", "**A mod carrying custom CSS is refused**",
      // web-widget
      "`set_web_widget { slot, spec?, data? }`", "`chat_header`", "`details`", "`context_pct`", "`cost_usd`", "at least **10 s** apart", "`remove_web_widget { slot? }`",
      // new in beta.2: identity colour and effects
      "`identity`: `{ color?, show? }`", "first match wins: a **person's** pick", "`show_source`",
      "`upload_web_effect { dir }`", "`list_web_effects`", "`apply_web_effect { id, params? }`", "`remove_web_effect { id? }`", "`delete_web_effect { id }`", "`profile_web_effect { id }`", "`preview_web_effect({id})`",
      "**`mention` is reserved and never fires in 2.3.0**", "**Your `front` effects are paused while the viewer's custom CSS is on, loading or unknown**",
    ];
    for (const f of facts) expect(FLAT, f).toContain(f);
    expect(SKILL).not.toMatch(/Settings → Appearance/);
  });
  const OLD = AGENT_WHATS_NEW.filter(e => compareVersions(e.since, "2.2.0")! <= 0).map(e => e.id);
  const SIX = ["2.3-owner-effect-policy", "2.3-web-theme", "2.3-web-card", "2.3-web-appearance", "2.3-web-mod", "2.3-web-widget"];
  it("an instance told everything of 2.2 hears the two 2.3 topic lines once from 2.3.0-beta.2 — never on a 2.2.x or beta.1", () => {
    for (const version of ["2.2.5", "2.3.0-alpha.1", "2.3.0-beta.1"]) expect(planWhatsNew({ record: { announced: OLD }, fresh: false, version }), version).toBeNull();
    for (const [version, ids] of [["2.3.0-beta.2", ["2.3-web-appearance-topic", "2.3-repo-tools"]], ["2.3.0", ["2.3-web-appearance-topic", "2.3-web-settings-for-the-user", "2.3-repo-tools"]]] as const) {
      const plan = planWhatsNew({ record: { announced: OLD }, fresh: false, version });
      expect(plan && "ids" in plan ? plan.ids : plan, version).toEqual(ids);
    }
    expect(planWhatsNew({ record: { announced: AGENT_WHATS_NEW.map(e => e.id) }, fresh: false, version: "2.3.0" })).toBeNull();
  });
  it("one told the six detailed entries on 2.3.0-beta.1 hears the two short lines once on beta.2, then nothing", () => {
    const plan = planWhatsNew({ record: { announced: [...OLD, ...SIX] }, fresh: false, version: "2.3.0-beta.2" });
    expect(plan && "ids" in plan ? plan.ids : plan).toEqual(["2.3-web-appearance-topic", "2.3-repo-tools"]);
    expect(planWhatsNew({ record: { announced: [...OLD, ...SIX, "2.3-web-appearance-topic", "2.3-repo-tools"] }, fresh: false, version: "2.3.0-beta.2" })).toBeNull();
    const later = planWhatsNew({ record: { announced: [...OLD, ...SIX, "2.3-web-appearance-topic", "2.3-repo-tools"] }, fresh: false, version: "2.3.0" });
    expect(later && "ids" in later ? later.ids : later, "#2056: beta.3's line, once").toEqual(["2.3-web-settings-for-the-user"]);
  });
});

describe("one preview file rule in two places (#1890 review)", () => {
  it("web-appearance-view's and web-asset-parts' PREVIEW_FILE are the same (the second keeps agend-agent small)", () => {
    expect(PARTS_PREVIEW_FILE.source).toBe(VIEW_PREVIEW_FILE.source);
    expect(PARTS_PREVIEW_FILE.flags).toBe(VIEW_PREVIEW_FILE.flags);
  });
});
