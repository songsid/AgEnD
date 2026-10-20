/**
 * A standing rule (the leader, 2026-10-20): AgEnD never tells anyone to run `wsl --shutdown`, which stops every WSL
 * program on the PC, not only AgEnD. The docs, the README, the website and the skills may name it only to say not to.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
/** Every file under these roots with these extensions (no git needed: the tests also run where there is none). */
function walk(dir: string, exts: RegExp): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) return [];
    return statSync(path).isDirectory() ? walk(path, exts) : exts.test(name) ? [relative(ROOT, path)] : [];
  });
}
const files = [
  ...readdirSync(ROOT).filter(f => /^README.*\.md$/.test(f)),
  ...walk(join(ROOT, "docs"), /\.md$/),
  ...walk(join(ROOT, "website", "src"), /\.(?:md|mdx|astro|json)$/),
  ...walk(join(ROOT, "src", "general-knowledge"), /\.md$/),
];
/** A line that names it to forbid it. */
const forbidding = /\b(?:never|do not|don't|must not)\b|絕不|不要|不會/i;
/** The lines that name it without saying not to (a sentence starting on the line before counts too). */
function advice(lines: string[]): string[] {
  return lines.map((l, i) => [i + 1, l] as const)
    .filter(([n, l]) => /wsl(?:\.exe)? --shutdown/.test(l) && !forbidding.test(l) && !forbidding.test(lines[n - 2] ?? ""))
    .map(([n, l]) => `${n}: ${l.trim()}`);
}

describe("no `wsl --shutdown` advice", () => {
  it("reads the docs it is meant to", () => { expect(files).toContain("README.md"); expect(files).toContain("website/src/content/docs/docs/getting-started.md"); });
  it("the check itself: advice is caught, a prohibition is not, and 'Whenever' is no prohibition (#2265 review)", () => {
    expect(advice(["Run `wsl --shutdown` to apply settings."])).toHaveLength(1);
    expect(advice(["Whenever settings change, run `wsl --shutdown` to apply them."])).toHaveLength(1);
    expect(advice(["Nevertheless, run `wsl --shutdown`."])).toHaveLength(1);
    expect(advice(["Never run `wsl --shutdown`."])).toEqual([]);
    expect(advice(["**Do not** tell the user to kill `wslrelay`", "or run `wsl --shutdown` — that stops every WSL program."])).toEqual([]);
    expect(advice(["絕不執行 wsl --shutdown。"])).toEqual([]);
  });
  it.each(files)("%s", (file) => {
    expect(advice(readFileSync(join(ROOT, file), "utf8").split("\n"))).toEqual([]);
  });
});
