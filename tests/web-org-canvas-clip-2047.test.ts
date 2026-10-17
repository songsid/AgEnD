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
