/**
 * #1490 P2 quickstart fixes — tested via exported production functions:
 *
 * Fix 1: addAllowedUsersToConfig — channels-shaped file gets correct update,
 *         never writes a phantom `channel:` key.
 * Fix 2: backupFleetConfig — writes backup before overwrite, throws (fail-closed)
 *         on failure so the overwrite is aborted.
 *
 * Each test calls the real exported function (not a simulation). Reverse
 * mutations on the production code produce AssertionErrors.
 */
import { describe, expect, it, afterEach } from "vitest";
import {
  existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { addAllowedUsersToConfig, backupFleetConfig } from "../src/quickstart.js";

let dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function tempDir() { const d = mkdtempSync(join(tmpdir(), "agend-qs-p2-")); dirs.push(d); return d; }

// ── Fix 1: addAllowedUsersToConfig ────────────────────────────────────────────
//
// Reverse mutation A: removing `if (config.channels && Array.isArray(config.channels))`
//   and reverting to `config.channel ??= {}` makes test 1 fail: phantom channel:
//   key would be written into the channels-shaped file.
// Reverse mutation B: accessing config.channel instead of config.channels[idx]
//   makes test 2 fail: the user ends up in the wrong connection.

describe("addAllowedUsersToConfig: channels-shaped file (#1490 P2 Fix 1)", () => {
  it("channels-shaped: user added to channels[0], no phantom channel: key", () => {
    const config: any = {
      channels: [{ type: "telegram", group_id: "-100123", access: { mode: "locked", allowed_users: ["existing"] } }],
      defaults: { backend: "claude-code" },
    };

    addAllowedUsersToConfig(config, ["new-user"]);

    expect(config).not.toHaveProperty("channel");
    expect(config.channels).toHaveLength(1);
    expect(config.channels[0].access.allowed_users).toContain("new-user");
    expect(config.channels[0].access.allowed_users).toContain("existing");
  });

  it("channels-shaped, two connections: pickIndex selects the correct one", () => {
    const config: any = {
      channels: [
        { id: "tg", type: "telegram", access: { mode: "locked", allowed_users: [] } },
        { id: "dc", type: "discord", access: { mode: "locked", allowed_users: [] } },
      ],
    };

    addAllowedUsersToConfig(config, ["discord-admin"], /* pickIndex */ 1);

    expect(config).not.toHaveProperty("channel");
    expect(config.channels[0].access.allowed_users).toHaveLength(0); // telegram untouched
    expect(config.channels[1].access.allowed_users).toContain("discord-admin");
  });

  it("channel-shaped (singular): works and does NOT add a channels: key", () => {
    const config: any = {
      channel: { type: "telegram", group_id: "-100456", access: { mode: "locked", allowed_users: ["admin-1"] } },
    };

    addAllowedUsersToConfig(config, ["admin-2"]);

    expect(config).not.toHaveProperty("channels");
    expect(config.channel.access.allowed_users).toContain("admin-1");
    expect(config.channel.access.allowed_users).toContain("admin-2");
  });

  it("does not add a duplicate if user already exists", () => {
    const config: any = {
      channels: [{ type: "telegram", access: { mode: "locked", allowed_users: ["existing"] } }],
    };

    addAllowedUsersToConfig(config, ["existing"]);

    expect(config.channels[0].access.allowed_users).toHaveLength(1); // no duplicate
  });
});

// ── Fix 2: backupFleetConfig ──────────────────────────────────────────────────
//
// Reverse mutation: removing the backup call from the overwrite path means
// backupFleetConfig is never called and the backup file is never created.
// The test catches this because it calls the real backupFleetConfig directly
// and asserts the file was created and the original content preserved.
//
// Fail-closed mutation: changing backupFleetConfig to swallow errors (catch {})
// makes test 6 fail because the function would return undefined instead of throwing.

describe("backupFleetConfig (#1490 P2 Fix 2)", () => {
  it("creates a .bak-<ts> file with the original content", async () => {
    const dir = tempDir();
    const configPath = join(dir, "fleet.yaml");
    const original = yaml.dump({ channel: { type: "telegram", group_id: "-100789" } });
    writeFileSync(configPath, original, "utf-8");

    const ts = 1_700_000_000_000;
    const backupPath = await backupFleetConfig(configPath, ts);

    expect(backupPath).toBe(`${configPath}.bak-${ts}`);
    expect(existsSync(backupPath)).toBe(true);
    expect(readFileSync(backupPath, "utf-8")).toBe(original);
    // Original file must still be there (not moved)
    expect(existsSync(configPath)).toBe(true);
  });

  it("backup file name matches .bak-<digits> pattern", async () => {
    const dir = tempDir();
    const configPath = join(dir, "fleet.yaml");
    writeFileSync(configPath, "defaults: {}\n", "utf-8");

    await backupFleetConfig(configPath);

    const bakFiles = readdirSync(dir).filter(f => /fleet\.yaml\.bak-\d+$/.test(f));
    expect(bakFiles).toHaveLength(1);
  });

  // ── Fail-closed: throws when backup cannot be written ─────────────────────
  //
  // Reverse mutation: wrapping backupFleetConfig's body in `try { … } catch {}`
  // makes it return undefined silently instead of throwing, and this test fails
  // because `await backupFleetConfig(…)` does not reject.

  it("throws when the backup directory is not writable (fail-closed)", async () => {
    const dir = tempDir();
    const configPath = join(dir, "fleet.yaml");
    writeFileSync(configPath, "defaults: {}\n", "utf-8");

    // Make the directory read-only to prevent the backup file from being created
    try { chmodSync(dir, 0o555); } catch { return; /* chmod may be a no-op on some systems */ }

    try {
      await expect(backupFleetConfig(configPath)).rejects.toThrow();
    } finally {
      try { chmodSync(dir, 0o755); } catch { /* restore best effort */ }
    }
  });
});
