/**
 * #2047: org-chart cards shorten names by drawn width, not by character count. SVG text never wraps or ellipsizes, and
 * a CJK character draws about 1.6 Latin ones, so a 15-character budget let 15 CJK characters run 60+ px past a card.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { page, type AppPage } from "./helpers/app-harness.js";

let p: AppPage, C: any;
beforeAll(async () => { p = page({ url: "http://127.0.0.1:19281/ui/fleet/org" }); C = await import("/ui/js/fleet-canvas.js"); });
afterAll(() => p.restore());
const width = (s: string) => Array.from(s).reduce((w, ch) => w + (/[⺀-꓏＀-｠]|\p{Extended_Pictographic}/u.test(ch) ? 1.6 : 1), 0);

describe("clipText (#2047)", () => {
  it("keeps Latin text as before: 15 characters fit, 16 become 14 + …", () => {
    expect(C.clipText("rd1-platform-be", 15)).toBe("rd1-platform-be");
    expect(C.clipText("rd1-platform-backend", 15)).toBe("rd1-platform-b…");
  });
  it("shortens CJK by width: the result never exceeds the budget", () => {
    for (const s of ["平台基礎設施與發佈工程負責人（主要）", "效能分析與火焰圖解讀", "研一官網-t1544335726169165914", "資料平台 dbt 模型新鮮度監控", "多語系翻譯校對（繁中）"]) {
      for (const n of [15, 20, 27]) expect(width(C.clipText(s, n))).toBeLessThanOrEqual(n);
    }
    expect(C.clipText("效能分析與火焰圖解讀", 15)).toBe("效能分析與火焰圖…");   // 10 CJK = 16 > 15
    expect(C.clipText("效能分析與火焰圖解讀", 20)).toBe("效能分析與火焰圖解讀");  // 16 ≤ 20: whole
  });
  it("never splits a surrogate pair", () => {
    const out = C.clipText("𠀀𠀁𠀂𠀃𠀄𠀅𠀆𠀇𠀈𠀉𠀊", 10);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
  });
});

describe("clipText keeps graphemes whole (Fable P3 on #2048)", () => {
  it("never splits a ZWJ sequence, a skin-tone modifier or a flag", () => {
    expect(C.clipText("ab👨‍👩‍👧cdefgh", 6)).not.toMatch(/‍…|👨…/);
    expect(C.clipText("x👍🏽yzzzzz", 4)).toBe("x👍🏽…");
    for (const s of ["ab👨‍👩‍👧cdefgh", "x👍🏽yzzzzzzzzz", "🇹🇼🇹🇼🇹🇼🇹🇼🇹🇼🇹🇼", "é́é́é́é́é́é́é́é́"]) for (const n of [3, 4, 5, 6, 8]) {
      const out = C.clipText(s, n), seg = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(out.replace(/…$/, ""))].map(x => x.segment);
      const whole = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)].map(x => x.segment);
      expect(seg).toEqual(whole.slice(0, seg.length));
    }
  });
});

describe("clipText prices an emoji sequence by its parts (Prism R1 on #2063)", () => {
  const units = (s: string) => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)].reduce((w, { segment: g }) => {
    const p = Array.from(g).filter(c => /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(c)).length;
    return w + (p ? 2 * p : /[⺀-꓏＀-｠]/.test(g) ? 1.6 : 1);
  }, 0);
  it("repeated ZWJ families and flags stay whole and within the budget", () => {
    for (const s of ["👨‍👩‍👧".repeat(10) + "suffix", "🇹🇼".repeat(12) + "tail", "👨‍👩‍👧‍👦x".repeat(6)]) for (const n of [6, 15, 20, 27]) {
      const out = C.clipText(s, n), body = out.replace(/…$/, "");
      const seg = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(body)].map(x => x.segment);
      expect(seg).toEqual([...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)].map(x => x.segment).slice(0, seg.length));
      expect(units(body) + (out.endsWith("…") ? 1 : 0)).toBeLessThanOrEqual(n);
    }
    expect(C.clipText("👨‍👩‍👧".repeat(10) + "suffix", 20)).toBe("👨‍👩‍👧".repeat(3) + "…");   // 3 families = 18, + … = 19
  });
});
