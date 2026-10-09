/**
 * #1519 P1 (docs/design/ux-onboarding-walkthrough.md §5.2): a connection's token env name is generated —
 * `AGEND_<PLATFORM>_<ID>_TOKEN`, unique, never reserved — and a new connection never takes a name another holds.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { envFileKeys, generateTokenEnvName, newTokenEnvConflict, takenTokenEnvNames, tokenEnvBase, TOKEN_ENV_PATTERN } from "../src/token-env-name.js";
import { providerRegistryEnvKeys } from "../src/provider-secret-registry.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("the generated name", () => {
  it("platform and id, upper-cased, the id reduced to [A-Z0-9_]; the platform's own id adds nothing", () => {
    expect([tokenEnvBase("discord", "discord"), tokenEnvBase("discord", "persona1"), tokenEnvBase("telegram", "telegram-2"),
      tokenEnvBase("discord", "my bot.é-x")]).toEqual(["AGEND_DISCORD_TOKEN", "AGEND_DISCORD_PERSONA1_TOKEN", "AGEND_TELEGRAM_2_TOKEN", "AGEND_DISCORD_MY_BOT_X_TOKEN"]);
  });
  it("a suffix on collision; every result fits the pattern and 64 characters", () => {
    const taken = new Set(["AGEND_DISCORD_TOKEN", "AGEND_DISCORD_2_TOKEN"]);
    expect(generateTokenEnvName("discord", "discord", taken)).toBe("AGEND_DISCORD_3_TOKEN");
    const long = generateTokenEnvName("telegram", "x".repeat(80), new Set());
    expect([TOKEN_ENV_PATTERN.test(long), long.length <= 64]).toEqual([true, true]);
    const full = new Set([long]);
    const next = generateTokenEnvName("telegram", "x".repeat(80), full);
    expect([next !== long, TOKEN_ENV_PATTERN.test(next), next.length <= 64]).toEqual([true, true, true]);
  });
  it("never a provider key, a reserved name, a connection's, a key in .env or in this process's environment", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-envname-")); dirs.push(dir);
    writeFileSync(join(dir, ".env"), "# comment\nexport AGEND_TELEGRAM_TOKEN=x\nOTHER=1\n");
    const taken = takenTokenEnvNames({ channelEnvs: ["AGEND_TELEGRAM_2_TOKEN", null], envFile: envFileKeys(dir), processEnv: ["AGEND_TELEGRAM_3_TOKEN"] });
    expect(generateTokenEnvName("telegram", "telegram", taken)).toBe("AGEND_TELEGRAM_4_TOKEN");
    for (const key of providerRegistryEnvKeys()) expect(taken.has(key), key).toBe(true);
    expect(envFileKeys(join(dir, "missing"))).toEqual(new Set());
  });
});

describe("a new connection's name", () => {
  const channels = [{ id: "telegram", token_env: "AGEND_TELEGRAM_TOKEN" }];
  it("is refused when another connection holds it, when reserved or a provider's, or malformed", () => {
    expect(newTokenEnvConflict("AGEND_TELEGRAM_TOKEN", channels) ?? "").toMatch(/"telegram" connection/);
    expect(newTokenEnvConflict("PATH", channels) ?? "").toMatch(/reserved/);
    expect(newTokenEnvConflict([...providerRegistryEnvKeys()][0]!, channels) ?? "").toMatch(/reserved/);
    expect(newTokenEnvConflict("lower", channels) ?? "").toMatch(/UPPER_SNAKE/);
  });
  it("is allowed when only .env has it (the pre-fleet form names AGEND_BOT_TOKEN itself)", () => {
    expect(newTokenEnvConflict("AGEND_BOT_TOKEN", channels)).toBeNull();
  });
});
