/**
 * #2050 (the 2.3 realistic sweep): the preview SVG lays the card's text out to its column (SVG text neither wraps nor
 * clips, so a 60-grapheme CJK tagline ran off the image), and the server resolver's English model text, the tooltip's
 * source suffixes and the fallback group "Other" are shown in the page's language.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { page, type AppPage } from "./helpers/app-harness.js";
import { fitLines, previewSvg } from "../src/web-appearance-view.js";

const TAG = "部署前檢查清單：確認所有服務的健康檢查、資料庫遷移與回滾腳本都已在預備環境驗證完成並通知值班人員與相關團隊成員";
// Not the layout's own estimate: a floor every font meets (CJK one em, anything else at least 0.5 em), so a test can tell
// a line that is surely too long. Real drawn widths are measured in scripts/manual/preview-text-2050.mts.
const floorPx = (s: string, size: number) => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)].reduce((w, g) => w + (/[\u2e80-\ua4cf\uff00-\uff60]/.test(g.segment) ? size : size * 0.5), 0);

describe("fitLines (#2050)", () => {
  it("wraps CJK to the column and ends what does not fit with …", () => {
    const lines = fitLines(TAG.repeat(2), 300, 15, 2);
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(floorPx(l, 15)).toBeLessThanOrEqual(300);
    expect(lines[1].endsWith("…")).toBe(true);
  });
  it("keeps text that fits whole, and its own line breaks", () => {
    expect(fitLines("short", 300, 15, 2)).toEqual(["short"]);
    expect(fitLines("one\ntwo", 300, 13, 4)).toEqual(["one", "two"]);
    expect(fitLines("a\nb\nc", 300, 13, 2)).toEqual(["a", "b…"]);
  });
  it("never returns more than maxLines, even when a long paragraph follows a full set (Prism R1 P3)", () => {
    for (const max of [1, 2, 3]) {
      const lines = fitLines("a\nb\n" + "界".repeat(50), 300, 15, max);
      expect(lines.length).toBeLessThanOrEqual(max); expect(lines.at(-1)!.endsWith("…")).toBe(true);
    }
    expect(fitLines("one\n" + "界".repeat(50), 300, 15, 2)).toHaveLength(2);
  });
  it("bounds wide Latin conservatively: 60 capital W fit their columns, never one 60-character line", () => {
    for (const col of [688, 492]) { const lines = fitLines("W".repeat(60), col, 15, 2); expect(lines.join("")).toBe("W".repeat(60)); expect(lines.length).toBe(2); }
  });
  it("breaks Latin at a space", () => {
    const lines = fitLines("Release captain for the Android and iOS trains, weekly", 200, 15, 8);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines.slice(0, -1)) expect(l.endsWith(" ")).toBe(false);
    expect(lines.join(" ")).toBe("Release captain for the Android and iOS trains, weekly");
  });
});

describe("previewSvg card text (#2050)", () => {
  const svgOf = (card: any, portrait = false) => previewSvg({ entry: { name: "a", display_name: null } as any, theme: {} as any, card: { ...card, ...(portrait ? { portrait: { by: "human" } } : {}) },
    locked: false, agentEdit: false, limits: {} }, "dark", { avatar: null, portrait: portrait ? "portrait.jpg" : null, banner: null, background: null } as any);
  it("wraps a cap-length CJK tagline and bio, and clips the card text to its column", () => {
    for (const portrait of [false, true]) {
      const svg = svgOf({ tagline: { text: TAG, by: "human" }, bio: { text: TAG.repeat(4), by: "human" } }, portrait);
      const clip = /<clipPath id="card-text"><rect x="(\d+)" y="[\d.]+" width="(\d+)"/.exec(svg)!;
      expect(clip).not.toBeNull();
      const group = svg.slice(svg.indexOf('<g clip-path="url(#card-text)">'), svg.indexOf("</g>", svg.indexOf('<g clip-path="url(#card-text)">')));
      const texts = [...group.matchAll(/<text x="(\d+)"[^>]*font-size="(\d+)"[^>]*>([^<]*)<\/text>/g)];
      expect(texts.length).toBeGreaterThan(3);
      for (const [, x, size, text] of texts) { expect(+x).toBe(+clip[1]); expect(floorPx(text, +size)).toBeLessThanOrEqual(+clip[2]); }
    }
  });
});

let p: AppPage, nav: any, i18n: any;
beforeAll(async () => { p = page({ url: "http://127.0.0.1:19282/ui" }); i18n = await import("/assets/app-i18n.js"); nav = await import("/assets/instance-nav.js"); });
afterAll(() => p.restore());

describe("model and group text in the page's language (#2050)", () => {
  it("English keeps the server's words", () => {
    i18n.setLang("en");
    expect(nav.modelText({ model: "default (detected when it starts)", model_source: "unresolved" })).toBe("default (detected when it starts)");
    expect(nav.modelText({ model: "gpt-5.5 (default)", model_source: "cli-default" })).toBe("gpt-5.5 (default)");
    expect(nav.groupLabel("Other")).toBe("Other");
  });
  it("Traditional Chinese translates the resolver's text, the fallback group and nothing else", () => {
    i18n.setLang("zh-TW");
    expect(nav.modelText({ model: "default (detected when it starts)", model_source: "unresolved" })).toBe("預設（啟動時偵測）");
    expect(nav.modelText({ model: "default (this CLI does not report a default)", model_source: "unresolved" })).toBe("預設（這個 CLI 不提供預設值）");
    expect(nav.modelText({ model: "default (something new)", model_source: "unresolved" })).toBe("預設（something new）");
    expect(nav.modelText({ model: "gpt-5.5 (default)", model_source: "cli-default" })).toBe("gpt-5.5（預設）");
    expect(nav.modelText({ model: "claude-opus-5-5 (default)", model_source: "live" })).toBe("claude-opus-5-5 (default)");   // a real name, untouched
    expect(nav.modelText({ model: "", model_source: "unresolved" })).toBe("");
    expect(nav.groupLabel("Other")).toBe("其他");
    expect(nav.groupLabel("AgEnD")).toBe("AgEnD");
    i18n.setLang("en");
  });
});

describe("fitLines keeps graphemes whole (#2050, Fable on #2048)", () => {
  it("never splits an emoji sequence or a modifier from its base", () => {
    for (const s of ["ab👨‍👩‍👧cdefghijklmnop", "x👍🏽yzzzzzzzzzzzz", "🇹🇼🇹🇼🇹🇼🇹🇼🇹🇼🇹🇼🇹🇼🇹🇼"]) {
      for (const px of [20, 40, 60]) for (const line of fitLines(s, px, 15, 3)) {
        expect(line).not.toMatch(/‍(…|$)/);                          // no dangling joiner
        expect(line).not.toMatch(/^[\u{1f3fb}-\u{1f3ff}‍]/u);        // no orphan modifier or joiner at a line start
        expect([...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(line)].every(g => !/^[\u{1f1e6}-\u{1f1ff}]$/u.test(g.segment))).toBe(true);
      }
    }
  });
});
