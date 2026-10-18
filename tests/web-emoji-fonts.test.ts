/**
 * The user's tofu boxes (Discord hmsg-49fbf692, relayed by the leader): emoji the dashboard's text fonts lack must be
 * drawn by the platform's colour emoji font, never a box. Every font stack the dashboard ships ends with the emoji
 * chain — the stock tokens (--font-ui, --font-mono via --font-emoji), each agent-theme font (.th-font-system: its own
 * stack; .th-font-mono: --font-mono), the effect-trial frame, the /login terminal and the session-ended banner — and no
 * stylesheet sets a literal font stack without it.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const CHAIN = ['"Apple Color Emoji"', '"Segoe UI Emoji"', '"Noto Color Emoji"', "emoji"];
const FILES = ["src/ui/shared/app.css", "src/ui/shared/effect-trial.css", "src/ui/web-terminal/terminal.css", "src/ui/signin.html"];

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
  it("the session-ended banner's inline font too", () => {
    const auth = read("src/ui/shared/agend-auth.js");
    const font = /font:14px ([^;]+);/.exec(auth)![1]!;
    for (const f of CHAIN) expect(font.replace(/\\"/g, '"'), f).toContain(f);
  });
});
