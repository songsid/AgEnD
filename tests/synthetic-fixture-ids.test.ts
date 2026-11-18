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

describe("synthetic fixture ids", () => {
  it("allows repeated-digit and 1-then-zeros padded ids", () => {
    expect(isSynthetic19DigitId("1".repeat(19))).toBe(true);
    expect(isSynthetic19DigitId("0".repeat(19))).toBe(true);
    expect(isSynthetic19DigitId("1000000000000000001")).toBe(true);
    expect(isSynthetic19DigitId("1000000000000000002")).toBe(true);
    expect(isSynthetic19DigitId("1000000000005793300")).toBe(true);
    expect(isSynthetic19DigitId("15" + "32671461406277715")).toBe(false);
  });

  it("git grep -t1 + 18 digits finds only synthetic ids", () => {
    const r = spawnSync("git", ["grep", "-nE", "--", "-t1[0-9]{18}"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(r.error).toBeUndefined();
    const lines = (r.stdout ?? "").split("\n").filter(Boolean);
    const bad: string[] = [];
    for (const line of lines) {
      for (const m of line.matchAll(/-t(1[0-9]{18})/g)) {
        if (!isSynthetic19DigitId(m[1])) bad.push(line);
      }
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });
});
