/**
 * Guard: tree text may use a 19-digit `-t` suffix only when the digits are
 * obviously fake (repeated run, or 1 followed by a long zero pad).
 */
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/** True for a 19-digit id that is allowed in fixtures. */
export function isSynthetic19DigitId(digits: string): boolean {
  if (!/^\d{19}$/.test(digits)) return false;
  if (/^(\d)\1{18}$/.test(digits)) return true;
  if (/^10{10,}\d*$/.test(digits)) return true;
  return false;
}

/** A completed `git grep`: 0 = matches, 1 = none. Launch failures, signals, null status, and fatals are not a scan. */
export function isCompletedGitGrep(r: {
  error?: Error;
  status: number | null;
  signal: NodeJS.Signals | number | null;
}): boolean {
  return r.error === undefined && r.signal == null && (r.status === 0 || r.status === 1);
}

export function unsyntheticT1Hits(stdout: string): string[] {
  const bad: string[] = [];
  for (const line of (stdout ?? "").split("\n").filter(Boolean)) {
    for (const m of line.matchAll(/-t(1[0-9]{18})/g)) {
      if (!isSynthetic19DigitId(m[1])) bad.push(line);
    }
  }
  return bad;
}

describe("synthetic fixture ids", () => {
  it("allows repeated-digit and 1-then-zeros padded ids", () => {
    expect(isSynthetic19DigitId("1".repeat(19))).toBe(true);
    expect(isSynthetic19DigitId("0".repeat(19))).toBe(true);
    expect(isSynthetic19DigitId("1000000000000000001")).toBe(true);
    expect(isSynthetic19DigitId("1000000000000000002")).toBe(true);
    expect(isSynthetic19DigitId("1000000000005793300")).toBe(true);
    expect(isSynthetic19DigitId("15" + "32671461406277715")).toBe(false);
  });

  it("a launched fatal scan with empty stdout is not a completed no-match", () => {
    const r = { status: 128 as number | null, signal: null, stdout: "", stderr: "fatal: not a git repository" };
    expect(isCompletedGitGrep(r)).toBe(false);
    expect(unsyntheticT1Hits(r.stdout)).toEqual([]);
  });

  it("a completed no-match scan (status 1, empty stdout) is success", () => {
    const r = { status: 1 as number | null, signal: null, stdout: "" };
    expect(isCompletedGitGrep(r)).toBe(true);
    expect(unsyntheticT1Hits(r.stdout)).toEqual([]);
  });

  it("rejects a signal or a null status", () => {
    expect(isCompletedGitGrep({ status: null, signal: "SIGTERM" })).toBe(false);
    expect(isCompletedGitGrep({ status: null, signal: null })).toBe(false);
  });

  it("git grep -t1 + 18 digits finds only synthetic ids", () => {
    const r = spawnSync("git", ["grep", "-nE", "--", "-t1[0-9]{18}"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(isCompletedGitGrep(r), r.stderr?.trim() || `git grep status ${r.status} signal ${r.signal}`).toBe(true);
    expect(unsyntheticT1Hits(r.stdout ?? "")).toEqual([]);
  });
});
