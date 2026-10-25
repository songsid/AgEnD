/**
 * The text-only CI job runs only the tests in scripts/ci/docs-reading-tests.txt.
 * A test that reads the repo docs/, a root README*.md, or website content pages
 * and is missing from that list would let a docs PR merge red.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const LIST = join(ROOT, "scripts", "ci", "docs-reading-tests.txt");

function listed(): string[] {
  return readFileSync(LIST, "utf8").split("\n")
    .map(l => l.replace(/#.*$/, "").trim())
    .filter(Boolean);
}

/** True when the file reads the repository docs/README/website content trees. Scratch-repo fixtures do not count. */
function readsDocs(source: string): boolean {
  if (/new URL\(\s*['"]\.\.\/docs\//.test(source)) return true;
  if (/walk\(\s*join\(\s*ROOT,\s*['"]docs['"]/.test(source)) return true;
  if (/readFileSync\(\s*['"]docs\//.test(source)) return true;
  if (/\bread\(\s*['"]docs\//.test(source)) return true;
  if (/copyFileSync\(\s*join\(\s*ROOT,\s*['"]docs['"]/.test(source)) return true;
  if (/join\(\s*ROOT,\s*['"]docs['"]/.test(source) && /readFileSync|copyFileSync/.test(source)) return true;
  if (/source\(\s*['"](?:docs\/|README)/.test(source)) return true;
  if (/it\.each\(\s*\[\s*['"](?:docs\/|README)/.test(source)) return true;
  if (/readFileSync\(\s*new URL\(\s*`?['"]\.\.\/website\/src\/content/.test(source)) return true;
  if (/website\/\$\{path\}/.test(source) && /src\/content\/docs/.test(source)) return true;
  if (/join\(\s*import\.meta\.dirname,\s*['"]\.\.['"],\s*file\)/.test(source) && /['"]docs\//.test(source)) return true;
  if (/src\/content\/notes/.test(source) && /readFileSync|readdirSync/.test(source)) return true;
  return false;
}

describe("docs-reading test list", () => {
  const files = listed();

  it("every listed path exists", () => {
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(readFileSync(join(ROOT, f), "utf8").length).toBeGreaterThan(0);
  });

  it("every test that reads docs/README/website content is listed", () => {
    const missing: string[] = [];
    const listedSet = new Set(files);
    for (const name of readdirSync(join(ROOT, "tests"))) {
      if (!name.endsWith(".test.ts")) continue;
      const rel = `tests/${name}`;
      const source = readFileSync(join(ROOT, rel), "utf8");
      if (readsDocs(source) && !listedSet.has(rel)) missing.push(rel);
    }
    expect(missing, `add to scripts/ci/docs-reading-tests.txt:\n${missing.join("\n")}`).toEqual([]);
  });
});
