/**
 * The concepts doc is the agents' built-in role reference (fleet decision 9af8d799):
 * src/general-knowledge/skills/concepts/SKILL.md carries docs/concepts.md, so the
 * authors and reviewers who sync worker skills read the same definitions the user
 * approved. roles [general, worker]: General receives every playbook, workers only
 * the skills marked for them (#2163).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const SKILL = join(ROOT, "src", "general-knowledge", "skills", "concepts", "SKILL.md");
const DOC = join(ROOT, "docs", "concepts.md");

function splitFrontmatter(text: string): { head: string; body: string } {
  const m = text.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!m) throw new Error("concepts SKILL.md has no frontmatter");
  return { head: m[1], body: text.slice(m[0].length) };
}

describe("concepts skill mirrors docs/concepts.md", () => {
  it("frontmatter names the skill and publishes it to General and workers", () => {
    const { head } = splitFrontmatter(readFileSync(SKILL, "utf8"));
    expect(head).toMatch(/^name: concepts$/m);
    expect(head).toMatch(/^roles: \[general, worker\]$/m);
  });
  it("body is the doc, so edits land in exactly one place", () => {
    const { body } = splitFrontmatter(readFileSync(SKILL, "utf8"));
    expect(body.trim()).toBe(readFileSync(DOC, "utf8").trim());
  });
});
