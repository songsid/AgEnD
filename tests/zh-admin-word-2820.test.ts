/**
 * M-2820 (S-120 found both): zh-TW has ONE word for admin — 管理員 (docs/terminology.md). #3553's role words and
 * settings-devices.js said 管理者 while Settings, the app shell, the outside-connection card and the Hub said 管理員.
 * Every shipped zh-TW string, doc, site page and change fragment uses 管理員; the glossary names it.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const SKIP = new Set(["node_modules", ".git", "dist", "fixtures"]);
function files(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const n of readdirSync(dir)) {
    if (SKIP.has(n)) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.(ts|js|mjs|mts|md|mdx|html|json)$/.test(n)) out.push(p);
  }
  return out;
}
const OLD = "管理者";   // the word this card retired (spelled as escapes so this file is not a hit itself)

describe("M-2820: one zh-TW word for admin", () => {
  it("no 管理者 in src, docs, the website, change fragments or manual scripts (the glossary's rule line and the released CHANGELOG aside)", () => {
    const hits = ["src", "docs", "website/src", "changes", "scripts"].flatMap(d => files(join(ROOT, d)))
      .filter(f => !f.endsWith(join("docs", "terminology.md")))
      // Released notes are history: docs/CHANGELOG*.md is written only by the assemble commit (scripts/changelog-guard.mjs).
      .filter(f => !/[\\/]docs[\\/]CHANGELOG[^\\/]*\.md$/.test(f))
      .filter(f => readFileSync(f, "utf8").includes(OLD))
      .map(f => f.slice(ROOT.length + 1));
    expect(hits).toEqual([]);
  });
  it("the glossary names 管理員 for admin", () => {
    const g = readFileSync(join(ROOT, "docs", "terminology.md"), "utf8");
    expect(g).toMatch(/\| Admin \| admin \| 管理員 \| 管理員 \|/);
  });
  it("the strings that said 管理者 now say 管理員 (keys unchanged: an older page still finds them)", async () => {
    const { setLocale, t } = await import("../src/locale.js");
    setLocale("zh-TW");
    expect(t("web_auth.refusal_not_admin")).toBe("這個帳號已不再是 fleet 管理員。");
    expect(t("settings_confirm.host_operator_label")).toContain("管理員");
    setLocale("en");
  });
});
