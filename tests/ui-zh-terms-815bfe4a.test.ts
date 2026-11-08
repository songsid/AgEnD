/**
 * Decision 815bfe4a (user 2026-11-08): zh-TW text keeps the English product terms **Agent** and **Fleet** — never 代理 or
 * 艦隊 (General and Hub stay English too). docs/design/ui-style-guide.md rule 11.
 *
 * Every source file that can put text in front of a person (src/**, the web UI's string tables and the bot's locale
 * included) is scanned. 代理 is allowed only as 反向代理 (a reverse proxy: not the product term). There is no other
 * allowlist: a new exception needs a decision, not an entry here.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const SRC = join(ROOT, "src");
const TEXT = /\.(?:[cm]?[jt]s|html|css|json)$/;
/** 艦隊 anywhere; 代理 unless it is 反向代理 (a reverse proxy). */
export const FORBIDDEN = /艦隊|(?<!反向)代理/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (TEXT.test(name)) out.push(p);
  }
  return out;
}

export function offenders(files: Array<{ path: string; text: string }>): string[] {
  const found: string[] = [];
  for (const f of files) {
    f.text.split("\n").forEach((line, i) => {
      for (const m of line.matchAll(FORBIDDEN)) found.push(`${f.path}:${i + 1}: …${line.slice(Math.max(0, m.index! - 20), m.index! + 22)}…`);
    });
  }
  return found;
}

describe("zh-TW product terms: Agent and Fleet, never 代理 / 艦隊 (decision 815bfe4a)", () => {
  it("no source file under src/ says 代理 or 艦隊 (a reverse proxy, 反向代理, is not the product term)", () => {
    const files = walk(SRC).map((p) => ({ path: relative(ROOT, p), text: readFileSync(p, "utf8") }));
    expect(files.length).toBeGreaterThan(100);   // the walk reached the tree
    expect(offenders(files)).toEqual([]);
  });
  it("the check itself: catches both terms, keeps 反向代理 and the English terms", () => {
    const hit = (text: string) => offenders([{ path: "x.js", text }]).length;
    expect(hit(`zh: "這個艦隊已關閉預覽"`)).toBe(1);
    expect(hit(`zh: "指令沒有送到代理"`)).toBe(1);
    expect(hit(`zh: "代理人"`)).toBe(1);
    expect(hit(`zh: "艦隊和代理"`)).toBe(2);
    expect(hit(`zh: "透過 TLS 反向代理到達"`)).toBe(0);
    expect(hit(`zh: "這個 Fleet 的 Agent"`)).toBe(0);
  });
});
