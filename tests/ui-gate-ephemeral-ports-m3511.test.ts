/**
 * M-3510 / M-3511: a ui-gate smoke once could not start because its fixed port (HP + 1, inside Linux's ephemeral range) was
 * held by something else on the runner. Every ui-gate smoke now boots its fixture on ephemeral ports read back
 * (`port: 0`), with its old ports held as the control (`oldPort`). This pins it for every smoke the runner discovers —
 * including new ones: no fixed port is passed to bootFixture, and each boot names its old port.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discover } from "../scripts/ci/ui-gate-smokes.mjs";

const smokes = discover() as Array<{ file: string; hp: number }>;
const bootCalls = (src: string) => [...src.matchAll(/bootFixture\(\{([^}]*)/g)].map((m) => m[1]!);

describe("every ui-gate smoke boots on ephemeral ports (M-3511)", () => {
  it("the runner finds the smokes (this pin checks something)", () => {
    expect(smokes.length).toBeGreaterThanOrEqual(30);
  });
  it.each(smokes.map((s) => [s.file, s.hp] as const))("%s: bootFixture({ port: 0, oldPort: … }) and no fixed port", (file) => {
    const calls = bootCalls(readFileSync(join(process.cwd(), file), "utf8"));
    expect(calls.length, "it boots the fixture").toBeGreaterThan(0);
    for (const opts of calls) {
      expect(opts, "ephemeral").toMatch(/(^|[\s,])port: 0[,\s]/);
      expect(opts, "its old port held as the control").toMatch(/\boldPort: /);
      expect(opts, "no fixed port passed").not.toMatch(/(^|[\s,])port: (?!0[,\s])/);
    }
  });
  it("grep proof: no ui-gate smoke passes a fixed 48xxx/49xxx/19xxx port to its fixture", () => {
    const fixed = smokes.flatMap((s) => bootCalls(readFileSync(join(process.cwd(), s.file), "utf8"))
      .filter((o) => /(^|[\s,])port: (?:Number\(process\.env\.HP|\d{4,5}\b)/.test(o)).map(() => s.file));
    expect(fixed).toEqual([]);
  });
});
