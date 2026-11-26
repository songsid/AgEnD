/**
 * The user's tofu boxes (Discord hmsg-49fbf692, relayed by the leader): emoji the dashboard's text fonts lack must be
 * drawn by the platform's colour emoji font, never a box. Every font stack the dashboard ships ends with the emoji
 * chain — the stock tokens (--font-ui, --font-mono via --font-emoji), each agent-theme font (.th-font-system: its own
 * stack; .th-font-mono: --font-mono), the /login terminal and the session-ended banner — and no
 * stylesheet sets a literal font stack without it.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const CHAIN = ['"Apple Color Emoji"', '"Segoe UI Emoji"', '"Noto Color Emoji"', "emoji"];
const FILES = ["src/ui/shared/app.css", "src/ui/web-terminal/terminal.css", "src/ui/signin.html"];

/** Each font stack a stylesheet sets: the families of every `font-family:` and the family part of every `font:` shorthand. */
function stacks(css: string): string[] {
  const out: string[] = [];
  for (const m of css.matchAll(/(?<![-\w])font-family\s*:\s*([^;}]+)/g)) out.push(m[1]!.trim());
  for (const m of css.matchAll(/(?<![-\w])font\s*:\s*([^;}]+)/g)) {
    const v = m[1]!.replace(/!important/, "").trim();
    if (v === "inherit") continue;
    // The family list starts after the size (with an optional /line-height).
    const fam = /\d[\d.]*(?:px|r?em|%)(?:\/[\w.()-]+)?\s+(.+)$/.exec(v.replace(/var\(--fs-\w+\)(?:\/var\(--lh-\w+\))?/, "16px"));
    out.push(fam ? fam[1]!.trim() : v);
  }
  return out;
}

describe("emoji are drawn by an emoji font, never a box", () => {
  it("--font-emoji names the platforms' colour emoji fonts and the emoji generic; --font-ui and --font-mono end with it", () => {
    const tokens = read("src/ui/shared/tokens.css");
    const emoji = /--font-emoji:\s*([^;]+);/.exec(tokens)![1]!;
    for (const f of [...CHAIN, '"Segoe UI Symbol"']) expect(emoji, f).toContain(f);
    for (const t of ["--font-ui", "--font-mono"]) expect(new RegExp(`${t}:[^;]+, var\\(--font-emoji\\);`).test(tokens), t).toBe(true);
  });
  it("each agent-theme font keeps the chain: system has its own stack ending with it; mono is --font-mono", () => {
    const app = read("src/ui/shared/app.css");
    expect(/\.th-font-system[^{]*\{\s*font-family:[^;]*var\(--font-emoji\)/.test(app)).toBe(true);
    expect(/\.th-font-mono[^{]*\{\s*font-family:\s*var\(--font-mono\)/.test(app)).toBe(true);
  });
  it.each(FILES)("%s: every font stack is a token or ends with the emoji chain", (file) => {
    const found = stacks(read(file)).filter((s) => !/^"Inter"$/.test(s));                 // the @font-face's own name
    expect(found.length, "it sets fonts").toBeGreaterThan(0);
    for (const s of found) {
      const ok = /^var\(--font-(ui|mono|emoji)(, ?monospace)?\)$/.test(s) || /var\(--font-emoji\)\s*$/.test(s) || CHAIN.every((f) => s.includes(f));
      expect(ok, `${file}: ${s}`).toBe(true);
    }
  });
  // M-3796 (the user's grey 🆕 on Win11 Edge, confirmed on Edge 158 with CSS.getPlatformFontsForNode): Noto Sans TC, earlier
  // in --font-ui, drew 🆕 🆗 🆓 🈶 in black and white; the font named Menlo on that machine drew ☕ ⚡ ♈ in --font-mono.
  describe("M-3796: emoji take the colour font even where a text font has its own glyph", () => {
    const tokens = read("src/ui/shared/tokens.css");
    const face = /@font-face \{\s*font-family: "AgEnD Emoji";([^}]*)\}/.exec(tokens)?.[1] ?? "";
    const ranges = (/unicode-range:\s*([^;]+);/.exec(face)?.[1] ?? "").split(",").map((r) => r.trim()).filter(Boolean)
      .map((r) => { const m = /^U\+([0-9A-F]+)(?:-([0-9A-F]+))?$/i.exec(r)!; expect(m, r).toBeTruthy(); return [parseInt(m[1]!, 16), parseInt(m[2] ?? m[1]!, 16)] as const; });
    const covers = (ch: string) => ranges.some(([lo, hi]) => ch.codePointAt(0)! >= lo && ch.codePointAt(0)! <= hi);

    it("a face of the platforms' colour emoji fonts, installed ones only (local(): nothing is downloaded)", () => {
      const src = /src:\s*([^;]+);/.exec(face)![1]!;
      for (const f of ["Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji"]) expect(src).toContain(`local("${f}")`);
      expect(src).not.toMatch(/url\(/);
    });
    it("covers emoji: 🆕 🆗 🆓 🈶, the faces, ☕ ⚡ ♈ ✅ ⭐ ❌, and the joiners that build a sequence", () => {
      for (const ch of ["🆕", "🆗", "🆓", "🈶", "👍", "🎉", "🔴", "🇹", "🏽", "☕", "⚡", "♈", "✅", "⭐", "❌", "⭕", "✨", "⌛", "\u200d", "\ufe0f", "\u20e3"]) expect(covers(ch), ch).toBe(true);
    });
    it("leaves text to the text fonts: digits, # and *, ©, ®, ™, ★, ♥, ☺, ✔, ❤, arrows, CJK, Latin, and the text-style selector", () => {
      for (const ch of ["0", "9", "#", "*", "©", "®", "™", "★", "♥", "☺", "✔", "❤", "→", "↩", "中", "の", "한", "a", "\ufe0e", "\u3030", "\u3297"]) expect(covers(ch), ch).toBe(false);
    });
    it("is the first family of every stack: --font-ui, --font-mono and the system theme font", () => {
      for (const t of ["--font-ui", "--font-mono"]) expect(new RegExp(`${t}:\\s*"AgEnD Emoji", `).test(tokens), t).toBe(true);
      expect(/\.th-font-system[^{]*\{\s*font-family:\s*"AgEnD Emoji", system-ui/.test(read("src/ui/shared/app.css"))).toBe(true);
    });
  });
  it("the session-ended banner's inline font too", () => {
    const auth = read("src/ui/shared/agend-auth.js");
    const font = /font:14px ([^;]+);/.exec(auth)![1]!;
    for (const f of [...CHAIN, '"Segoe UI Symbol"']) expect(font.replace(/\\"/g, '"'), f).toContain(f);
  });
});
