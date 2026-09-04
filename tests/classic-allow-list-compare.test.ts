import { describe, expect, it, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClassicChannelManager } from "../src/classic-channel-manager.js";

/**
 * The three allow-lists compared with a strict `includes`, while isAdmin in the
 * same file compared with String(). A hand-edited config can hold an UNQUOTED
 * id, which YAML parses as a number — and a numeric entry then never matched
 * the string an adapter supplies, so the chat was locked out with no error.
 *
 * This restores the author's intent rather than widening access: someone who
 * wrote `allowed_guilds: [111]` meant to allow 111, and was being denied.
 */
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function makeManager(yaml: string) {
  const dir = mkdtempSync(join(tmpdir(), "agend-allowcmp-"));
  dirs.push(dir);
  writeFileSync(join(dir, "classicBot.yaml"), yaml);
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;
  return { m: new ClassicChannelManager(dir, logger) as any, logger };
}

describe("allow-lists compare as strings", () => {
  it("matches an unquoted numeric guild id against the string a callback carries", () => {
    const { m } = makeManager('defaults:\n  allowed_guilds: [111, 222]\n');
    expect(m.isGuildAllowed("111")).toBe(true);    // was false: strict includes
    expect(m.isGuildAllowed("333")).toBe(false);   // still denied
  });

  it("matches an unquoted Telegram group id, negatives included", () => {
    // Telegram ids are negative and comfortably under 2^53, so YAML parses them
    // losslessly and String() genuinely recovers them.
    const { m } = makeManager('defaults:\n  allowed_groups: [-1001234567890]\n');
    expect(m.isGroupAllowed("-1001234567890")).toBe(true);
    expect(m.isGroupAllowed("-1009999999999")).toBe(false);
  });

  it("matches an unquoted allowed_users entry", () => {
    const { m } = makeManager('defaults:\n  allowed_users: [951494522]\n');
    expect(m.isUserAllowed("951494522")).toBe(true);
  });

  it("still honours quoted ids and still denies everything else", () => {
    const { m } = makeManager('defaults:\n  allowed_guilds: ["g1"]\n');
    expect(m.isGuildAllowed("g1")).toBe(true);
    expect(m.isGuildAllowed("g2")).toBe(false);
  });

  it("keeps allow-all when the list is empty or absent", () => {
    const { m } = makeManager('defaults:\n  admin_users: ["1"]\n');
    expect(m.isGuildAllowed("anything")).toBe(true);
    expect(m.isGroupAllowed("anything")).toBe(true);
  });

  it("does NOT invent a match for a snowflake YAML already truncated", () => {
    // The honest limit of this fix. 1496407196106494055 unquoted parses as
    // ...494000, so the last digits are gone before any comparison runs. No
    // string compare can recover them — the id must be re-entered in quotes.
    const { m, logger } = makeManager('defaults:\n  allowed_guilds: [1496407196106494055]\n');

    expect(m.isGuildAllowed("1496407196106494055")).toBe(false);
    // ...but it is no longer SILENT, which is the actual failure being removed.
    expect(logger.error).toHaveBeenCalled();
    const logged = JSON.stringify(logger.error.mock.calls);
    expect(logged).toContain("allowed_guilds");
    expect(logged).toMatch(/quoted string/i);
  });

  it("adds the correct id alongside a broken one rather than repairing it", () => {
    // A truncated entry cannot equal the real id, so it is not seen as a
    // duplicate. Access starts working immediately via the new quoted entry;
    // the broken line stays until a human removes it, because nothing here
    // should silently discard something the operator wrote.
    const { m } = makeManager('defaults:\n  allowed_guilds: [1496407196106494055]\n');
    expect(m.allowGuild("1496407196106494055")).toBe("added");

    expect(m.isGuildAllowed("1496407196106494055")).toBe(true);   // works now
    expect(m.defaults.allowed_guilds).toHaveLength(2);            // broken one kept
    expect(m.defaults.allowed_guilds.some((v: unknown) => typeof v === "number")).toBe(true);
  });

  it("reports a bad id once at load, not on every write", () => {
    // One unquoted id used to emit an error on every save. The operator has
    // already been told and cannot fix it from this side.
    const { m, logger } = makeManager('defaults:\n  allowed_guilds: [1496407196106494055]\n');
    expect(logger.error).toHaveBeenCalledTimes(1);

    m.allowGuild("a"); m.allowGuild("b");
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("says nothing about ids that are fine", () => {
    const { logger } = makeManager('defaults:\n  allowed_guilds: ["g1", 111]\n');
    expect(logger.error).not.toHaveBeenCalled();
  });
});
