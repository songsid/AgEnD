/**
 * M-3652: the daily CLI watch's tripwire for Claude server flags the binary precheck cannot see. Under
 * `tengu_eager_brooks`, 2.1.331 compacts a cold --continue with no prompt; the watch must say so per profile, and print
 * nothing else from the file (no tokens, account fields or other flag values).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const SCRIPT = new URL("../scripts/manual/cli-upstream-precheck/claude-flag-watch.py", import.meta.url).pathname;
const root = mkdtempSync(join(tmpdir(), "claude-flag-watch-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function profile(name: string, body: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, ".claude.json");
  writeFileSync(file, body);
  return file;
}
const run = (...files: string[]) => spawnSync("python3", ["-I", SCRIPT, ...files], { encoding: "utf8" });

describe("claude-flag-watch (M-3652)", () => {
  const secret = "sk-ant-oat01-" + "x".repeat(24);
  const on = profile("alpha", JSON.stringify({
    cachedGrowthBookFeatures: { tengu_eager_brooks: true, tengu_amber_tally: { fiveHourCredits: { t: 7 } }, other: "OTHERVALUE" },
    oauthAccount: { emailAddress: "person@example.test" }, primaryApiKey: secret,
  }));
  const off = profile("beta", JSON.stringify({ cachedGrowthBookFeatures: { tengu_eager_brooks: false } }));
  const wrapped = profile("gamma", JSON.stringify({ cachedGrowthBookFeatures: { tengu_eager_brooks: { defaultValue: true } } }));
  const absent = profile("delta", JSON.stringify({ cachedGrowthBookFeatures: { tengu_amber_tally: {} } }));
  const noCache = profile("epsilon", JSON.stringify({ theme: "dark" }));
  const broken = profile("zeta", "{ not json");

  it("warns once per profile where the flag turns up, saying whether it is on", () => {
    const r = run(on, off, wrapped, absent, noCache);
    expect(r.status).toBe(0);
    expect(r.stdout.trim().split("\n")).toEqual([
      expect.stringMatching(/^WARN claude-flags alpha: server flag tengu_eager_brooks is present \(on\) - .*idleCompaction:false/),
      expect.stringMatching(/^WARN claude-flags beta: server flag tengu_eager_brooks is present \(not on\) - /),
      expect.stringMatching(/^WARN claude-flags gamma: server flag tengu_eager_brooks is present \(on\) - /),
    ]);
  });

  it("prints no token, account field or other flag value", () => {
    const out = run(on).stdout;
    for (const leak of [secret, "person@example.test", "OTHERVALUE", "fiveHourCredits", "tengu_amber_tally", "oauthAccount"]) expect(out).not.toContain(leak);
  });

  it("says so in one line when no profile has it", () => {
    const r = run(absent, noCache);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("claude-flags: none of tengu_eager_brooks in 2 profile(s)\n");
  });

  it("an unreadable profile is a WARN, never a failure of the watch", () => {
    const r = run(broken, absent);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("WARN claude-flags zeta: its .claude.json cannot be read; the flag tripwire skipped it\n");
  });
});
