/**
 * AGEND-115 S3: src/ui/cli-caps.js is generated from the registry (src/cli-caps-module.ts, `npx tsx scripts/gen-cli-caps.mts`). It must be exactly what the registry renders, and the
 * scripts that read it must not write a list of CLIs out again.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CLI_IDS } from "../src/cli-capability.js";
import { renderCliCapsModule, uiCliCaps } from "../src/cli-caps-module.js";
import { CLI_CAPS, FIRST_RUN_BACKENDS, capsOf } from "/ui/js/cli-caps.js";

describe("src/ui/cli-caps.js", () => {
  it("is what the registry renders (run `npx tsx scripts/gen-cli-caps.mts` after changing a spec)", () => {
    expect(readFileSync(new URL("../src/ui/cli-caps.js", import.meta.url), "utf8")).toBe(renderCliCapsModule());
  });

  it("says, for every CLI the registry knows, what the registry says, and is frozen", () => {
    expect(Object.keys(CLI_CAPS)).toEqual([...CLI_IDS]);
    expect(CLI_CAPS).toEqual(uiCliCaps());
    expect(Object.isFrozen(CLI_CAPS)).toBe(true);
    expect(Object.isFrozen(CLI_CAPS["claude-code"])).toBe(true);
    expect(Object.isFrozen(FIRST_RUN_BACKENDS)).toBe(true);
    expect(capsOf("claude-code")).toBe(CLI_CAPS["claude-code"]);
  });

  it("holds booleans and words only: no command, no path, nothing a page could run", () => {
    const text = readFileSync(new URL("../src/ui/cli-caps.js", import.meta.url), "utf8");
    expect(text).not.toMatch(/\b(?:fetch|eval|import\(|require|Function\()/);
    for (const caps of Object.values(CLI_CAPS)) for (const value of Object.values(caps as Record<string, unknown>)) expect(["boolean", "string"].includes(typeof value) || value === null).toBe(true);
  });

  it("the dashboard's scripts read it: none of them writes the lists out again", () => {
    for (const file of ["accounts-manage.js", "accounts-view.js", "backend-signin.js", "settings-dialogs.js", "runtime-cli-install.js"]) {
      const source = readFileSync(new URL(`../src/ui/${file}`, import.meta.url), "utf8");
      expect(source, file).toContain("./cli-caps.js");
      expect(source, file).not.toMatch(/\[\s*"(?:claude-code|kiro-cli|codex|antigravity)"\s*,\s*"(?:claude-code|kiro-cli|codex|antigravity)"/);
    }
  });
});
