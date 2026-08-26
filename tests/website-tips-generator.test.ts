import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TIPS } from "../src/tips.js";

describe("website tips pages", () => {
  const readPage = (locale: "en" | "zh") =>
    readFileSync(join(process.cwd(), "website", "public", `tips-${locale}.html`), "utf8");

  it.each(["en", "zh"] as const)("contains every tip in the %s page", locale => {
    const html = readPage(locale);
    expect(html.match(/data-tip-id="tip-\d{3}"/g)).toHaveLength(TIPS.length);
    expect(html.match(/data-level="beginner"/g)).toHaveLength(100);
    expect(html.match(/data-level="intermediate"/g)).toHaveLength(100);
    expect(html.match(/data-level="advanced"/g)).toHaveLength(100);
  });

  it("keeps the two locales separate and linked", () => {
    const en = readPage("en");
    const zh = readPage("zh");
    expect(en).toContain(TIPS[0].text_en);
    expect(en).not.toContain(TIPS[0].text_zh);
    expect(en).toContain('href="./tips-zh.html"');
    expect(zh).toContain(TIPS[0].text_zh);
    expect(zh).not.toContain(TIPS[0].text_en);
    expect(zh).toContain('href="./tips-en.html"');
  });
});
