/**
 * M-3742 (Prism's #4462 triage), pinned from the shipped files:
 * - the HTML preview notice's "I understand" (.pv-banner .pv-ack, shared by the chat, the preview panel and a task card's
 *   files) is a real flat button: its own background, a --border-strong edge, no shadow; a 44 px box on a phone;
 * - the preview frame's 2 px edge is --warn mixed 85% into --bg: at least 3:1 against --bg and --surface in every palette,
 *   light and dark (--warn-line alone was ~1.9:1 on white and ~2.5:1 on dark);
 * - zh-TW says 優先級 (never 優先度) and 「Agent」 in the preview strings.
 */
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const css = read("src/ui/shared/app.css"), tokens = read("src/ui/shared/tokens.css");

const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: string, b: string) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const mix = (a: string, b: string, t: number) => "#" + [1, 3, 5].map((i) => Math.round(parseInt(a.slice(i, i + 2), 16) * t + parseInt(b.slice(i, i + 2), 16) * (1 - t)).toString(16).padStart(2, "0")).join("");

/** Every token block's --bg / --surface, with the --warn in force there (a palette inherits its tone's --warn). */
function palettes(): Array<{ block: string; bg: string; surface: string | null; warn: string }> {
  const out: Array<{ block: string; bg: string; surface: string | null; warn: string }> = [];
  const DARK_WARN = /--warn:\s*(#[0-9a-f]{6})/i.exec(tokens)![1]!;
  const LIGHT_WARN = [...tokens.matchAll(/--warn:\s*(#[0-9a-f]{6})/gi)].map((m) => m[1]!).find((w) => w !== DARK_WARN)!;
  for (const block of tokens.split(/\n(?=\S)/)) {
    const bg = /--bg:\s*(#[0-9a-f]{6})/i.exec(block), surface = /--surface:\s*(#[0-9a-f]{6})/i.exec(block);
    if (!bg) continue;
    out.push({ block: block.split("{")[0]!.trim().slice(0, 60), bg: bg[1]!, surface: surface ? surface[1]! : null, warn: lum(bg[1]!) > 0.5 ? LIGHT_WARN : DARK_WARN });
  }
  return out;
}

describe("M-3742: the preview notice and frame", () => {
  it("\"I understand\" is a real flat button (own background, a strong edge, no shadow), a 44 px box on a phone — the ghost look is overridden", () => {
    expect(css).toContain(".pv-banner .pv-ack, .pv-banner .pv-ack.btn-ghost { flex: none; background: var(--bg); border-color: var(--border-strong); color: var(--text); box-shadow: none; }");
    expect(css).toMatch(/@media \(max-width: 899px\), \(pointer: coarse\) \{ \.pv-banner \.pv-ack \{ min-height: var\(--tap\); \} \}/);
  });
  it("the frame's edge is --warn 85% into --bg, flat, 2 px", () => {
    expect(css).toContain(".preview-frame { display: block; width: 100%; border: 2px solid var(--warn-line); border-color: color-mix(in srgb, var(--warn) 85%, var(--bg));");
  });
  it("…which is at least 3:1 against --bg and --surface in every palette, light and dark (the old --warn-line was not)", () => {
    const rows = palettes();
    expect(rows.length).toBeGreaterThanOrEqual(10);
    for (const p of rows) {
      const edge = mix(p.warn, p.bg, 0.85);
      expect(ratio(edge, p.bg), `${p.block} on --bg`).toBeGreaterThanOrEqual(3);
      if (p.surface) expect(ratio(edge, p.surface), `${p.block} on --surface`).toBeGreaterThanOrEqual(3);
    }
    // The control: the light --warn-line alone, on white.
    expect(ratio("#e3b341", "#ffffff")).toBeLessThan(3);
  });
});

describe("M-3742: zh-TW words", () => {
  it("no UI string says 優先度 (優先級, the glossary's word)", () => {
    const hits = readdirSync(new URL("../src/ui/", import.meta.url), { recursive: true }).map(String).filter((f) => f.endsWith(".js"))
      .filter((f) => read(`src/ui/${f}`).includes("優先度"));
    expect(hits).toEqual([]);
    expect(read("src/ui/fleet-task-common.js")).toContain('priority: "優先級"');
  });
  it("the preview strings say 「Agent」, never a lowercase agent", () => {
    const zh = read("src/ui/shared/chat-strings.js").split('"zh-TW"')[1]!;
    const pv = zh.split("\n").filter((l) => /\bpv[A-Z]\w*:/.test(l) && /[一-鿿]/.test(l));
    expect(pv.length).toBeGreaterThan(5);
    expect(pv.filter((l) => /(?<![A-Za-z])agent(?![A-Za-z])/.test(l))).toEqual([]);
    expect(zh).toContain("預覽會在隔離的框架裡執行 Agent 的 HTML。");
  });
});
