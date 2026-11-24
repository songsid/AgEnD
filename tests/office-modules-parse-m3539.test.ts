/**
 * M-3539 (#4376): a stacked PR merged after its base landed squashed can come out with a block twice — no textual
 * conflict, so GitHub says CLEAN — and a duplicated top-level `const` (STUDIO_LARGE_AREAS in fleet-office-skin.js) is
 * a SyntaxError that stops the office module from loading, for the Fleet and the room office alike. Every office
 * drawing module must parse as the browser loads it (node --check, as an ES module).
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const UI = join(__dirname, "..", "src", "ui");
const MODULES = readdirSync(UI).filter((f) => /^(fleet-office[\w-]*|hub-room-office)\.js$/.test(f)).sort();
const check = (path: string) => spawnSync(process.execPath, ["--check", path], { encoding: "utf8" });

describe("M-3539 the office modules load", () => {
  it("finds the office drawing modules (fleet-office-skin.js among them)", () => {
    expect(MODULES).toContain("fleet-office-skin.js");
    expect(MODULES.length).toBeGreaterThan(10);
  });
  it.each(MODULES)("%s parses", (name) => {
    const r = check(join(UI, name));
    expect(r.status, r.stderr).toBe(0);
  });
  it("control: a duplicated top-level const does not parse (what the squash-stack merge produced)", () => {
    const dir = mkdtempSync(join(tmpdir(), "office-parse-"));
    try {
      const f = join(dir, "dup.mjs");
      writeFileSync(f, "const STUDIO_LARGE_AREAS = {};\nconst STUDIO_LARGE_AREAS = {};\nexport { STUDIO_LARGE_AREAS };\n");
      const r = check(f);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("has already been declared");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
