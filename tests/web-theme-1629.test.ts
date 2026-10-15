/**
 * #1629 (first design §1, §8, §9.1–2): the theme is typed values only — a closed schema, types never coerced,
 * canonical forms stored and served, contrast checked per mode against the token defaults (pinned to tokens.css), and
 * set_web_theme's patch applied all-or-nothing.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyThemePatch, canonicalColor, checkTheme, contrastRatio, THEME_DEFAULTS, THEME_MAX_BYTES } from "../src/web-theme.js";

const A = "0123456789abcdef0123456789abcdef";
const ctx = { assets: new Set([A]) };
const problems = (input: unknown) => { const r = checkTheme(input, ctx); return r.ok ? [] : r.errors.map(e => e.path); };

describe("typed values only (§9.1)", () => {
  it.each([
    ["an unknown top-level key", { v: 1, css: "x" }, "css"],
    ["v other than 1", { v: 2 }, "v"],
    ["a colour with CSS after it", { accent: "#fff; background:url(x)" }, "accent"],
    ["var()", { accent: "var(--x)" }, "accent"],
    ["a named colour", { accent: "red" }, "accent"],
    ["5 hex digits", { accent: "#12345" }, "accent"],
    ["7 hex digits", { accent: "#1234567" }, "accent"],
    ["rgb()", { accent: "rgb(1,2,3)" }, "accent"],
    ["expression()", { accent: "expression(1)" }, "accent"],
    ["a number for a colour", { accent: 0xffffff }, "accent"],
    ["an unknown mode", { colors: { sepia: {} } }, "colors.sepia"],
    ["an unknown palette key", { colors: { dark: { link: "#ffffff" } } }, "colors.dark.link"],
    ["radius not an integer", { bubble: { radius: 1.5 } }, "bubble.radius"],
    ["radius out of range", { bubble: { radius: 25 } }, "bubble.radius"],
    ["radius as a string", { bubble: { radius: "12" } }, "bubble.radius"],
    ["an unknown border", { bubble: { border: "dashed" } }, "bubble.border"],
    ["an unknown font", { font: "comic" }, "font"],
    ["a remote font url", { font: "https://x/f.woff2" }, "font"],
    ["background without fit", { background: { image: A, opacity: 1 } }, "background.fit"],
    ["background with an unknown asset", { background: { image: "f".repeat(32), fit: "cover", opacity: 1 } }, "background.image"],
    ["background with a url", { background: { image: "https://x/y.png", fit: "cover", opacity: 1 } }, "background.image"],
    ["opacity out of range", { background: { image: A, fit: "cover", opacity: 0.01 } }, "background.opacity"],
    ["opacity NaN", { background: { image: A, fit: "cover", opacity: Number.NaN } }, "background.opacity"],
    ["avatar not an asset of this instance", { avatar: "e".repeat(32) }, "avatar"],
    ["a label with a newline", { workingLabel: "Thinking\nhard" }, "workingLabel"],
    ["a label with a bidi override", { workingLabel: "Think‮ing" }, "workingLabel"],
    ["a label with a zero-width joiner trick", { workingLabel: "a​b" }, "workingLabel"],
    ["a label of 25 graphemes", { workingLabel: "x".repeat(25) }, "workingLabel"],
    ["an empty label", { workingLabel: "" }, "workingLabel"],
    // #1887 P3: one grapheme that draws nothing is not a label.
    ...["200d", "034f", "3164", "fe0f", "115f", "2800"].map((cp): [string, unknown, string] => [`an invisible-only label U+${cp}`, { workingLabel: String.fromCodePoint(parseInt(cp, 16)) }, "workingLabel"]),
    ["an array instead of an object", [], ""],
  ])("%s → refused at %s", (_n, input, path) => {
    expect(problems(input)).toContain(path);
  });
  it("only canonical forms are kept: colours lowercase #rrggbb, opacity on its 0.05 step, keys in one order", () => {
    const r = checkTheme({ workingLabel: "Thinking", accent: "#8B5CF6", colors: { light: { text: "#000" } }, background: { opacity: 0.333, fit: "cover", image: A } }, ctx);
    expect(r).toEqual({ ok: true, theme: { v: 1, colors: { light: { text: "#000000" } }, accent: "#8b5cf6", background: { image: A, fit: "cover", opacity: 0.35 }, workingLabel: "Thinking" } });
    expect(JSON.stringify((r as { theme: unknown }).theme)).toBe('{"v":1,"colors":{"light":{"text":"#000000"}},"accent":"#8b5cf6","background":{"image":"' + A + '","fit":"cover","opacity":0.35},"workingLabel":"Thinking"}');
  });
  it("a label counts graphemes (a family emoji is one), and is stored NFC", () => {
    expect(checkTheme({ workingLabel: "👨‍👩‍👧".repeat(24) }, ctx).ok).toBe(true);
    const r = checkTheme({ workingLabel: "é" }, ctx);
    expect(r.ok && r.theme.workingLabel).toBe("é");
  });
  it("canonicalColor: #rgb and #rrggbb only", () => {
    expect(["#ABC", "#a1B2c3", "#abcd", "abc", " #abc", "#abc "].map(canonicalColor)).toEqual(["#aabbcc", "#a1b2c3", null, null, null, null]);
  });
});

describe("contrast, per mode (§9.2)", () => {
  it("each pair below its threshold is refused, naming the pair and its ratio", () => {
    const r = checkTheme({ colors: { dark: { text: "#3a3a3a" } } }, ctx);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors[0]).toEqual({ path: "colors.dark.text", problem: expect.stringMatching(/^contrast text on bg is 1\.\d\d:1, at least 4\.5:1 is needed$/) });
    expect(problems({ colors: { light: { text2: "#aaaaaa" } } })).toContain("colors.light.text2");
    expect(problems({ colors: { light: { accent: "#cccccc" } } })).toContain("colors.light.accent");
    expect(problems({ colors: { dark: { userBubble: "#ececec" } } }), "text on the user's bubble").toContain("colors.dark.text");
  });
  it("the threshold itself is accepted (≥, not >)", () => {
    // text2 on the light surface (#f4f4f4): #707070 is 4.50:1 — at AA; #717171 is 4.44:1 — just under.
    expect(contrastRatio("#707070", "#f4f4f4")).toBeGreaterThanOrEqual(4.5);
    expect(checkTheme({ colors: { light: { text2: "#707070" } } }, ctx).ok).toBe(true);
    expect(checkTheme({ colors: { light: { text2: "#717171" } } }, ctx).ok).toBe(false);
  });
  it("a top-level accent is checked in both modes", () => {
    expect(problems({ accent: "#ffffff" })).toEqual(["colors.light.accent"]);
  });
  it("the defaults equal tokens.css (dark :root, and the light override)", () => {
    const css = readFileSync(join(process.cwd(), "src", "ui", "shared", "tokens.css"), "utf8");
    const block = (sel: RegExp) => { const m = sel.exec(css); if (!m) throw new Error(String(sel)); return css.slice(m.index, css.indexOf("}", m.index)); };
    const read = (b: string, v: string) => new RegExp(`--${v}:\\s*(#[0-9a-f]{6})`).exec(b)?.[1];
    for (const [mode, sel] of [["dark", /^:root \{/m], ["light", /^:root\[data-theme="light"\] \{/m]] as const) {
      const b = block(sel);
      const want = THEME_DEFAULTS[mode];
      expect([read(b, "bg"), read(b, "surface"), read(b, "text"), read(b, "text-2"), read(b, "accent"), read(b, "user-bubble")], mode)
        .toEqual([want.bg, want.surface, want.text, want.text2, want.accent, want.userBubble]);
      expect(want.agentBubble, "an agent message sits on the page background").toBe(want.bg);
    }
  });
});

describe("set_web_theme's patch", () => {
  const base = { v: 1 as const, accent: "#8b5cf6", bubble: { radius: 12, border: "thin" as const } };
  it("set merges by key; clear removes dotted paths; the result is checked whole", () => {
    const r = applyThemePatch(base, { set: { bubble: { radius: 4 }, font: "mono" }, clear: ["accent"] }, ctx);
    expect(r).toEqual({ ok: true, theme: { v: 1, bubble: { radius: 4, border: "thin" }, font: "mono" } });
    const c = applyThemePatch({ v: 1, colors: { dark: { bg: "#000000" } } }, { clear: ["colors.dark.bg"] }, ctx);
    expect(c).toEqual({ ok: true, theme: { v: 1 } });
  });
  it("all or nothing: one bad value refuses the whole patch", () => {
    const r = applyThemePatch(base, { set: { font: "mono", bubble: { radius: 99 } } }, ctx);
    expect(r.ok).toBe(false);
  });
  it("{} is a no-op; unknown patch keys and bad clear paths are refused", () => {
    expect(applyThemePatch(base, {}, ctx)).toEqual({ ok: true, theme: base });
    expect(applyThemePatch(base, { replace: {} }, ctx).ok).toBe(false);
    expect(applyThemePatch(base, { clear: ["colors[0]"] }, ctx).ok).toBe(false);
  });
  it("__proto__ in a patch is an unknown key, never a prototype", () => {
    const r = applyThemePatch(base, JSON.parse('{"set":{"__proto__":{"polluted":1}}}'), ctx);
    expect([r.ok, ({} as Record<string, unknown>).polluted]).toEqual([false, undefined]);
    expect(!r.ok && r.errors[0]!.path).toBe("__proto__");
  });
  it(`a theme over ${THEME_MAX_BYTES} bytes is refused`, () => {
    // The schema keeps a theme small; the cap is the backstop — reach it through the size check alone.
    const big = { v: 1, colors: { light: Object.fromEntries(["bg", "surface"].map(k => [k, "#ffffff"])) } };
    expect(checkTheme(big, ctx).ok).toBe(true);
    expect(THEME_MAX_BYTES).toBe(4096);
  });
});
