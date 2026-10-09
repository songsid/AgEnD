/**
 * #1539 review (Fable P3): one reading of .env for the fleet's start (loadEnvFile), a connection added to a running fleet
 * (loadEnvKeys) and the token-name generator (envFileKeys) — the same lines give the same keys and values to all three.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseEnvText } from "../src/env-file.js";
import { envFileKeys } from "../src/token-env-name.js";
import { FleetManager } from "../src/fleet-manager.js";
import { settingsFileResource, trySettingsLease } from "../src/settings-transaction.js";

const TRICKY = [
  "# a comment", "", "   ", "NO_EQUALS_SIGN",
  "AGEND_P3_PLAIN=plain-value",
  "export AGEND_P3_EXPORTED=exported-value",
  'AGEND_P3_DQ="double quoted"',
  "AGEND_P3_SQ='single quoted'",
  "AGEND_P3_EQ=a=b=c",
  "  AGEND_P3_SPACED = spaced",
  "AGEND_P3_DUP=first", "AGEND_P3_DUP=second",
  "=no-key",
].join("\n") + "\n";
const WANT: Array<[string, string]> = [
  ["AGEND_P3_PLAIN", "plain-value"], ["AGEND_P3_EXPORTED", "exported-value"], ["AGEND_P3_DQ", "double quoted"],
  ["AGEND_P3_SQ", "single quoted"], ["AGEND_P3_EQ", "a=b=c"], ["AGEND_P3_SPACED", " spaced"], ["AGEND_P3_DUP", "second"],
];

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); for (const [k] of WANT) delete process.env[k]; });

describe("parseEnvText", () => {
  it("skips comments, blanks, lines without '=' and an empty key; drops 'export ' and one pair of quotes; the last of a key wins", () => {
    expect([...parseEnvText(TRICKY)]).toEqual(WANT);
  });
});

describe("every reader of .env reads it the same way", () => {
  it("the start (loadEnvFile), a hot-added connection (loadEnvKeys) and envFileKeys agree on keys and values", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-envfile-")); dirs.push(dir);
    writeFileSync(join(dir, ".env"), TRICKY);
    const fm = new FleetManager(dir) as any;
    const lease = trySettingsLease([settingsFileResource(join(dir, ".env"))])!;
    try {
      fm.loadEnvFile(lease.owner);
      const atStart = WANT.map(([k]) => [k, process.env[k]]);
      for (const [k] of WANT) delete process.env[k];
      fm.loadEnvKeys(new Set(WANT.map(([k]) => k)), lease.owner);
      const hotAdded = WANT.map(([k]) => [k, process.env[k]]);
      expect(atStart).toEqual(WANT);
      expect(hotAdded, "a hot-added connection reads what the start reads").toEqual(atStart);
    } finally { lease.release(); }
    expect([...envFileKeys(dir)].sort()).toEqual(WANT.map(([k]) => k).sort());
  });
});
