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
const forbidding = /never|do not|don't|\*\*Do not\*\*|絕不|不要|不會/i;

describe("no `wsl --shutdown` advice", () => {
  it("reads the docs it is meant to", () => { expect(files).toContain("README.md"); expect(files).toContain("website/src/content/docs/docs/getting-started.md"); });
  it.each(files)("%s", (file) => {
    const lines = readFileSync(join(ROOT, file), "utf8").split("\n");
    const advice = lines.map((l, i) => [i + 1, l] as const).filter(([, l]) => /wsl(?:\.exe)? --shutdown/.test(l) && !forbidding.test(l));
    // Each line that names it must also say not to (a sentence that starts on the line before counts too).
    const unexplained = advice.filter(([n]) => !forbidding.test(lines[n - 2] ?? ""));
    expect(unexplained.map(([n, l]) => `${n}: ${l.trim()}`)).toEqual([]);
  });
});
