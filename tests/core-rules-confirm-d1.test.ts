/**
 * #3326 D1 (the user's decision hmsg-77256f66: never guide people to type a host command): the steering every agent loads
 * (src/general-knowledge/steering/core-rules.md) says where a held Settings change is confirmed — General, or the dashboard
 * card on this computer — and never sends anyone to `agend settings confirm` (an agent repeats what its rules say).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const RULES = readFileSync(join(__dirname, "..", "src", "general-knowledge", "steering", "core-rules.md"), "utf8");

describe("core-rules: confirming a held Settings change (D1)", () => {
  const line = RULES.split("\n").find(l => l.includes("get around a Settings confirmation")) ?? "";
  it("names General and the dashboard's confirmation card", () => {
    expect(line).toMatch(/General/);
    expect(line).toMatch(/confirmation card/);
  });
  it("never a command to type — not in this rule, nor anywhere in the core rules", () => {
    expect(line).not.toMatch(/agend settings confirm|`agend /);
    expect(RULES).not.toMatch(/agend settings confirm/);
  });
});
