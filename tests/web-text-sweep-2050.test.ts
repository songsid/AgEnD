/**
 * #2050 (the 2.3 realistic sweep): the preview SVG lays the card's text out to its column (SVG text neither wraps nor
 * clips, so a 60-grapheme CJK tagline ran off the image), and the server resolver's English model text, the tooltip's
 * source suffixes and the fallback group "Other" are shown in the page's language.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { page, type AppPage } from "./helpers/app-harness.js";
import { fitLines, previewSvg } from "../src/web-appearance-view.js";

const TAG = "部署前檢查清單：確認所有服務的健康檢查、資料庫遷移與回滾腳本都已在預備環境驗證完成並通知值班人員與相關團隊成員";
const em = (s: string, size: number) => Array.from(s).reduce((w, ch) => w + (/[⺀-꓏＀-｠]/.test(ch) ? size : size * 0.58), 0);

describe("fitLines (#2050)", () => {
  it("wraps CJK to the column and ends what does not fit with …", () => {
    const lines = fitLines(TAG.repeat(2), 300, 15, 2);
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(em(l, 15)).toBeLessThanOrEqual(300);
    expect(lines[1].endsWith("…")).toBe(true);
  });
  it("keeps text that fits whole, and its own line breaks", () => {
    expect(fitLines("short", 300, 15, 2)).toEqual(["short"]);
    expect(fitLines("one\ntwo", 300, 13, 4)).toEqual(["one", "two"]);
    expect(fitLines("a\nb\nc", 300, 13, 2)).toEqual(["a", "b…"]);
  });
  it("breaks Latin at a space", () => {
    const lines = fitLines("Release captain for the Android and iOS trains, weekly", 200, 15, 3);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines.slice(0, -1)) expect(l.endsWith(" ")).toBe(false);
    expect(lines.join(" ")).toBe("Release captain for the Android and iOS trains, weekly");
  });
});

describe("previewSvg card text (#2050)", () => {
  it("draws a cap-length CJK tagline inside the 720 px image", () => {
    const svg = previewSvg({ entry: { name: "a", display_name: null } as any, theme: {} as any, card: { tagline: { text: TAG, by: "human" }, bio: { text: TAG.repeat(4), by: "human" } } as any,
      locked: false, agentEdit: false, limits: {} }, "dark", { avatar: null, portrait: null, banner: null, background: null } as any);
    const texts = [...svg.matchAll(/<text x="(\d+(?:\.\d+)?)"[^>]*font-size="(\d+)"[^>]*>([^<]*)<\/text>/g)].map(m => ({ x: +m[1], size: +m[2], text: m[3] }));
    const card = texts.filter(t => t.size === 15 || t.size === 13).filter(t => /[一-鿿]/.test(t.text));
    expect(card.length).toBeGreaterThan(2);
    for (const t of card) expect(t.x + em(t.text, t.size)).toBeLessThanOrEqual(720 - 16);
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
