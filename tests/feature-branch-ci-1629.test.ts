/** #1629 landing: temporary feature-branch workflow admission is retired; other triggers stay. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";

const on = (file: string) => {
  const doc = yaml.load(readFileSync(join(process.cwd(), ".github", "workflows", file), "utf8")) as Record<string, unknown>;
  return (doc.on ?? doc[true as unknown as string]) as Record<string, { branches?: string[]; tags?: string[] } | null>;
};

describe("#1629 landing: workflows keep main/release admission only", () => {
  it.each([
    ["ci.yml", ["main", "release/**"], { branches: ["main", "release/**"], tags: ["v*"] }],
    ["gitleaks.yml", ["main", "release/**"], { branches: ["main", "release/**"] }],
    ["data-downgrade.yml", ["main"], { branches: ["main"] }],
  ])("%s: pull_request admission retired; push unchanged", (file, prBranches, push) => {
    const triggers = on(file);
    expect(triggers.pull_request?.branches).toEqual(prBranches);
    expect(triggers.pull_request?.branches).not.toContain("feat/2.3-web-mod");
    expect(triggers.push).toEqual(push);
  });
});
