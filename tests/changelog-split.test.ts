/**
 * scripts/changelog-split.mjs: a long-lived line's own CHANGELOG section → changes/ fragment pairs, the section
 * removed from both files (docs/development.md, "A long-lived line landing on `main`"). The real script runs with
 * `node` in scratch directories; nothing else is touched.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const SPLIT = join(process.cwd(), "scripts", "changelog-split.mjs");
const ASSEMBLE = join(process.cwd(), "scripts", "changelog-assemble.mjs");
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const EN = `# Changelog

## [2.2.0] - unreleased (web line, \`feature/2.2-web\`)

### Added
- **Web chat echo (#1320 part A).** Copied to the topic.
- (Web line, temporary) CI also runs on the line.
- **Web chat: Markdown, several lines.** Replies render.

  A second paragraph of the same entry.
  - a nested point
- **Web chat: tables (#1269).** Tables show.

### Security
- **No inline script (#1268).** script-src
  is strict.

### Upgrade Notes
- **[Behaviour change] The web panels sign in with a one-time code, and a
  dashboard link no longer carries the token (#1018).** Sign in again.

## [Unreleased]

### Fixed
- **Main fix (#2).** b

## [1.0.0] - 2026-01-01

### Fixed
- **Old fix (#0).** c
`;
const ZH = `# 變更紀錄

## [2.2.0] - 未發佈（web 線，\`feature/2.2-web\`）

### 新增 (Added)
- **Web chat 主題同步（#1320 part A）。** 同步。
- （web 線，暫時性）CI 也會跑。
- **Web 聊天：Markdown、多行。** 會渲染。

  同一則的第二段。
- **Web 聊天：表格（#1269）。** 表格。

### 安全 (Security)
- **不執行 inline script（#1268）。** script-src 很嚴。

### 升級注意事項 (Upgrade Notes)
- **[行為變更] 網頁面板改用一次性登入碼（#1018）。** 重新登入。

## [未發佈] (Unreleased)

### 修正 (Fixed)
- **主線修正（#2）。** b

## [1.0.0] - 2026-01-01

### 修正 (Fixed)
- **舊修正（#0）。** c
`;

function repo(en = EN, zh = ZH, changes: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "agend-changelog-split-"));
  dirs.push(root);
  mkdirSync(join(root, "docs")); mkdirSync(join(root, "changes"));
  writeFileSync(join(root, "docs", "CHANGELOG.md"), en);
  writeFileSync(join(root, "docs", "CHANGELOG.zh-TW.md"), zh);
  for (const [name, text] of Object.entries(changes)) writeFileSync(join(root, "changes", name), text);
  const run = (script: string, ...args: string[]) => spawnSync(process.execPath, [script, "--root", root, ...args], { encoding: "utf8" });
  const read = () => ({
    en: readFileSync(join(root, "docs", "CHANGELOG.md"), "utf8"),
    zh: readFileSync(join(root, "docs", "CHANGELOG.zh-TW.md"), "utf8"),
    changes: Object.fromEntries(readdirSync(join(root, "changes")).sort().map(n => [n, readFileSync(join(root, "changes", n), "utf8")])),
  });
  return { root, run, read, split: (...a: string[]) => run(SPLIT, ...a), assemble: (...a: string[]) => run(ASSEMBLE, ...a) };
}

const NAMES = [
  "1018-the-web-panels-sign-in", "1262-web-chat-markdown-several-lines", "1262-web-line-temporary-ci-also",
  "1268-no-inline-script", "1269-web-chat-tables", "1320-web-chat-echo",
].flatMap(n => [`${n}.md`, `${n}.zh-TW.md`]).sort();

describe("changelog-split: a release section → fragment pairs", () => {
  it("writes one pair per entry, verbatim, under the right section, and removes the section from both files", () => {
    const r = repo();
    const res = r.split("--release", "2.2.0", "--issue", "1262");
    expect(res.status, res.stderr).toBe(0);
    const { en, zh, changes } = r.read();
    expect(Object.keys(changes)).toEqual(NAMES);
    expect(changes["1262-web-chat-markdown-several-lines.md"]).toBe(
      "---\nsection: Added\n---\n- **Web chat: Markdown, several lines.** Replies render.\n\n  A second paragraph of the same entry.\n  - a nested point\n");
    expect(changes["1262-web-chat-markdown-several-lines.zh-TW.md"]).toBe("---\nsection: Added\n---\n- **Web 聊天：Markdown、多行。** 會渲染。\n\n  同一則的第二段。\n");
    // A bold summary that wraps onto a second line: the issue on that line is the one used.
    expect(changes["1018-the-web-panels-sign-in.md"]).toContain("section: Upgrade Notes\n---\n- **[Behaviour change] The web panels sign in");
    expect(changes["1268-no-inline-script.md"]).toBe("---\nsection: Security\n---\n- **No inline script (#1268).** script-src\n  is strict.\n");
    // The section is gone; everything else is byte-for-byte what it was.
    expect(en).toBe(EN.slice(0, EN.indexOf("## [2.2.0]")) + EN.slice(EN.indexOf("## [Unreleased]")));
    expect(zh).toBe(ZH.slice(0, ZH.indexOf("## [2.2.0]")) + ZH.slice(ZH.indexOf("## [未發佈]")));
    expect(r.assemble("--check").status).toBe(0);
  });

  it("round trip: assembling them back into [2.2.0] gives the same entries in the same subsections", () => {
    const r = repo();
    expect(r.split("--release", "2.2.0", "--issue", "1262").status).toBe(0);
    expect(r.assemble("--release", "2.2.0", "--date", "2026-11-01").status).toBe(0);
    const entries = (text: string) => {
      const sec = text.slice(text.indexOf("## [2.2.0]"), text.indexOf("\n## [", text.indexOf("## [2.2.0]") + 1));
      const out: Record<string, string[]> = {};
      let cur = "";
      for (const block of sec.split(/\n(?=### |- )/)) {
        if (block.startsWith("### ")) cur = block.split("\n")[0]!;
        else if (block.startsWith("- ")) (out[cur] ??= []).push(block.trimEnd());
      }
      for (const k of Object.keys(out)) out[k]!.sort();
      return out;
    };
    expect(entries(r.read().en)).toEqual(entries(EN));
    expect(entries(r.read().zh)).toEqual(entries(ZH));
  });

  it("two entries with the same issue and slug get distinct names", () => {
    const en = EN.replace("- **Web chat: tables (#1269).** Tables show.", "- **Web chat: tables (#1269).** Tables show.\n- **Web chat: tables (#1269).** More tables.");
    const zh = ZH.replace("- **Web 聊天：表格（#1269）。** 表格。", "- **Web 聊天：表格（#1269）。** 表格。\n- **Web 聊天：表格（#1269）。** 更多。");
    const r = repo(en, zh);
    expect(r.split("--release", "2.2.0", "--issue", "1262").status).toBe(0);
    expect(Object.keys(r.read().changes)).toEqual(expect.arrayContaining(["1269-web-chat-tables.md", "1269-web-chat-tables-2.md", "1269-web-chat-tables-2.zh-TW.md"]));
    expect(r.read().changes["1269-web-chat-tables-2.zh-TW.md"]).toContain("更多");
  });

  it("--dry-run lists the pairs and writes nothing", () => {
    const r = repo();
    const before = r.read();
    const res = r.split("--release", "2.2.0", "--issue", "1262", "--dry-run");
    expect(res.status).toBe(0);
    expect(res.stdout.match(/^would write changes\/\S+\.md \+ \.zh-TW\.md/gm)).toHaveLength(6);
    expect(res.stdout).toContain("6 pair(s)");
    expect(r.read()).toEqual(before);
  });
});

describe("changelog-split: refusals write nothing", () => {
  const refuses = (en: string, zh: string, args: string[], why: RegExp, changes: Record<string, string> = {}) => {
    const r = repo(en, zh, changes);
    const before = r.read();
    const res = r.split(...args);
    expect(res.status, res.stdout).toBe(1);
    expect(res.stderr).toMatch(why);
    expect(r.read()).toEqual(before);
  };
  const ARGS = ["--release", "2.2.0", "--issue", "1262"];

  it("a subsection with a different number of entries", () => {
    refuses(EN, ZH.replace("- **Web 聊天：表格（#1269）。** 表格。\n", ""), ARGS, /Added: 4 entries in docs\/CHANGELOG\.md, 3 in docs\/CHANGELOG\.zh-TW\.md/);
  });

  it("a pair naming different issues (the halves are out of order)", () => {
    // Swap two zh entries: counts still match, the pairing does not.
    const swapped = ZH.replace("- **Web chat 主題同步（#1320 part A）。** 同步。\n", "").replace("- **Web 聊天：表格（#1269）。** 表格。\n", "- **Web 聊天：表格（#1269）。** 表格。\n- **Web chat 主題同步（#1320 part A）。** 同步。\n");
    refuses(EN, swapped, ARGS, /Added #1: en names \[#1320\], zh-TW names \[\]/);
  });

  it("one half names an issue, the other none", () => {
    refuses(EN, ZH.replace("不執行 inline script（#1268）", "不執行 inline script"), ARGS, /Security #1: en names \[#1268\], zh-TW names \[\]/);
  });

  it("a subsection only one file has", () => {
    refuses(EN, ZH.replace(/### 安全 \(Security\)\n[^\n]*\n\n/, ""), ARGS, /Security: only in docs\/CHANGELOG\.md/);
  });

  it("an entry with no issue and no --issue", () => {
    refuses(EN, ZH, ["--release", "2.2.0"], /names no issue and there is no --issue/);
  });

  it("a target file that already exists, unless --force", () => {
    refuses(EN, ZH, ARGS, /changes\/1269-web-chat-tables\.md already exists \(--force overwrites\)/, { "1269-web-chat-tables.md": "mine\n" });
    const r = repo(EN, ZH, { "1269-web-chat-tables.md": "mine\n" });
    expect(r.split(...ARGS, "--force").status).toBe(0);
    expect(r.read().changes["1269-web-chat-tables.md"]).toContain("Tables show.");
  });

  it("an unknown subsection, a stray paragraph, an entry before any subsection, a missing section", () => {
    refuses(EN.replace("### Security", "### Removed"), ZH, ARGS, /unknown subsection "### Removed"/);
    refuses(EN.replace("### Added\n", "### Added\nSome intro text.\n"), ZH, ARGS, /not part of an entry/);
    refuses(EN.replace("\n### Added\n", "\n- **stray.** x\n### Added\n"), ZH, ARGS, /an entry before any/);
    refuses(EN, ZH, ["--release", "9.9.9", "--issue", "1"], /no `## \[9\.9\.9\]` section/);
  });

  it("bad arguments → exit 2", () => {
    const r = repo();
    for (const args of [[], ["--release", "2.2"], ["--release", "2.2.0", "--issue", "x"], ["--bogus"]]) {
      expect(r.split(...args).status, args.join(" ")).toBe(2);
    }
    expect(existsSync(join(r.root, "changes", "1269-web-chat-tables.md"))).toBe(false);
  });
});
