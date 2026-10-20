/**
 * A standing rule (the leader, 2026-10-20): AgEnD never tells anyone to run `wsl --shutdown`, which stops every WSL
 * program on the PC, not only AgEnD. The docs, the README, the website and the skills may name it only to say not to.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const files = execFileSync("git", ["ls-files", "README*.md", "docs/*.md", "docs/**/*.md", "website/src/**/*.md", "website/src/**/*.mdx", "website/src/**/*.astro", "website/src/i18n/*.json", "src/general-knowledge/**/*.md"], { cwd: ROOT, encoding: "utf8" })
  .split("\n").filter(Boolean);
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
