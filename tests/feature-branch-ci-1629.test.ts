/**
 * #1629: PRs into the 2.3.0 feature branch feat/2.3-web-mod get the same gates as PRs into main — CI, the secret scan
 * and the data-downgrade roundtrip — and nothing else about those workflows moves (pushes, tags, schedules).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";

const on = (file: string) => {
  const doc = yaml.load(readFileSync(join(process.cwd(), ".github", "workflows", file), "utf8")) as Record<string, unknown>;
  return (doc.on ?? doc[true as unknown as string]) as Record<string, { branches?: string[]; tags?: string[] } | null>;
};

describe("#1629: the feature branch's PRs run the gates", () => {
  it.each([
    ["ci.yml", ["main", "release/**", "feat/2.3-web-mod"], { branches: ["main", "release/**"], tags: ["v*"] }],
    ["gitleaks.yml", ["main", "release/**", "feat/2.3-web-mod"], { branches: ["main", "release/**"] }],
    ["data-downgrade.yml", ["main", "feat/2.3-web-mod"], { branches: ["main"] }],
  ])("%s: pull_request into it; push unchanged", (file, prBranches, push) => {
    const triggers = on(file);
    expect(triggers.pull_request?.branches).toEqual(prBranches);
    expect(triggers.push).toEqual(push);
  });
});
