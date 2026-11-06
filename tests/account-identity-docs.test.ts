import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Who is shown the masked e-mail and the plan is `tier === "admin" && surface === "local"` (src/windows-cli-api.ts accountIdentityVisible):
 * a fleet admin on the dashboard reached DIRECTLY (this machine, a LAN, a tailnet or the user's own proxy), not "on the machine that runs
 * AgEnD", and not the "local administrator" of the Windows Runtime computer (who creates profiles). The docs are a security statement, so
 * they must not claim a narrower (or different) audience than the code.
 */
const read = (p: string) => readFileSync(p, "utf8");
const paragraph = (text: string, marker: string) => {
  const start = text.indexOf(marker);
  expect(start, `${marker} is missing`).toBeGreaterThanOrEqual(0);
  const end = text.indexOf("\n", start);
  return text.slice(start, end < 0 ? undefined : end);
};
const WRONG = [/machine that runs AgEnD/i, /executing AgEnD/i, /執行 AgEnD 的那台/, /local administrator/i, /本機管理員/];

describe("the account-identity audience in the docs", () => {
  it("says a fleet admin on the directly reached dashboard, and who is left out, in English", () => {
    const text = paragraph(read("docs/remote-runtime.md"), "**Only a fleet admin on the dashboard reached directly sees these details**");
    expect(text).toContain("(web-dashboard.md#the-three-ways-in-compared)");
    for (const word of ["this machine", "a LAN", "a tailnet", "your own proxy", "temporary public link", "named tunnel", "even a fleet admin's", "guest or read-only", "header token"]) expect(text, word).toContain(word);
    for (const wrong of WRONG) expect(text, String(wrong)).not.toMatch(wrong);
  });
  it("says the same in zh-TW", () => {
    const text = paragraph(read("docs/remote-runtime.zh-TW.md"), "**只有直接連到 dashboard 的 fleet 管理員看得到這些詳細資訊**");
    expect(text).toContain("(web-dashboard.zh-TW.md#三種連線方式比較)");
    for (const word of ["這台電腦", "區網", "tailnet", "自己的 proxy", "臨時公開連結", "named tunnel", "即使是 fleet 管理員也一樣", "guest", "唯讀", "CLI header token"]) expect(text, word).toContain(word);
    for (const wrong of WRONG) expect(text, String(wrong)).not.toMatch(wrong);
  });
  it("links to headings that exist", () => {
    expect(read("docs/web-dashboard.md")).toMatch(/^## The three ways in, compared$/m);
    expect(read("docs/web-dashboard.zh-TW.md")).toMatch(/^## 三種連線方式比較$/m);
  });
  it("keeps the wrong wording out of the changelog fragments and the code the audience is decided in", () => {
    for (const file of ["changes/3190-account-identity-followups.md", "changes/3190-account-identity-followups.zh-TW.md"]) for (const wrong of WRONG) expect(read(file), `${file} ${wrong}`).not.toMatch(wrong);
    const gate = paragraph(read("src/windows-cli-api.ts"), " * Who may be shown WHICH account");
    expect(gate).not.toMatch(/local administrator/i);
  });
  it("matches what the code decides", () => {
    expect(read("src/windows-cli-api.ts")).toContain('v.session.tier === "admin" && v.session.surface === "local"');
  });
});
