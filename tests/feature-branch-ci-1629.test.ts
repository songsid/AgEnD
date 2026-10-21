/**
 * #1629 landing retired the 2.3 feature branch's own admission; 2.4 (#2347) admits every feature branch (feat/**) to the
 * PR checks instead. Pushes stay main/release only.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";

const on = (file: string) => {
  const doc = yaml.load(readFileSync(join(process.cwd(), ".github", "workflows", file), "utf8")) as Record<string, unknown>;
  return (doc.on ?? doc[true as unknown as string]) as Record<string, { branches?: string[]; tags?: string[] } | null>;
};

describe("PR admission: main, release/** and feat/** feature branches (#2347); pushes unchanged", () => {
  it.each([
    ["ci.yml", ["main", "release/**", "feat/**"], { branches: ["main", "release/**"], tags: ["v*"] }],
    ["gitleaks.yml", ["main", "release/**", "feat/**"], { branches: ["main", "release/**"] }],
    ["data-downgrade.yml", ["main"], { branches: ["main"] }],
  ])("%s: pull_request admission; push unchanged", (file, prBranches, push) => {
    const triggers = on(file);
    expect(triggers.pull_request?.branches).toEqual(prBranches);
    expect(triggers.pull_request?.branches).not.toContain("feat/2.3-web-mod");
    expect(triggers.push).toEqual(push);
  });
});
