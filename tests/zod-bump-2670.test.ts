/**
 * #2670: zod 4.3.6 → 4.6 changed two things AgEnD relies on. An offset datetime now needs seconds, and `.nullable()`
 * is emitted as a type list. Both are pinned back here, so the bump changes neither what agents may send nor what they see.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { TOOLS } from "../src/channel/mcp-tools.js";
import { CreateScheduleArgs, UpdateScheduleArgs } from "../src/outbound-schemas.js";

const tool = (name: string) => TOOLS.find(t => t.name === name)!.inputSchema as { properties: Record<string, any> };

describe("#2670: one-shot schedule times after the zod 4.6 bump", () => {
  it.each(["2026-07-26T14:00+08:00", "2026-07-26T14:00Z", "2026-07-26T14:00:00+08:00", "2026-07-26T14:00:00.250Z", "2028-02-29T00:00Z"])(
    "%s is still accepted (create and update)", at => {
      expect(CreateScheduleArgs.safeParse({ at, message: "m" }).success).toBe(true);
      expect(UpdateScheduleArgs.safeParse({ id: "s", at }).success).toBe(true);
    });

  it.each(["2026-07-26T14:00", "2026-07-26", "2026-07-26T24:00Z", "2026-02-30T10:00Z", "2027-02-29T10:00Z", "tomorrow 9am"])(
    "%s is still refused with the 4.3 message", at => {
      const r = CreateScheduleArgs.safeParse({ at, message: "m" });
      expect(r.success).toBe(false);
      expect(r.error!.issues.map(i => i.message)).toContain("Invalid ISO datetime");
      expect(UpdateScheduleArgs.safeParse({ id: "s", at }).success).toBe(false);
    });

  it("lists the same date-time format and minute-optional pattern zod 4.3 listed", () => {
    for (const name of ["create_schedule", "update_schedule"]) {
      const at = tool(name).properties.at;
      expect(at).toMatchObject({ type: "string", format: "date-time" });
      expect(new RegExp(at.pattern).test("2026-07-26T14:00+08:00")).toBe(true);
      expect(at.pattern).toContain("[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|");
    }
  });
});

describe("#2670: nullable fields keep the zod 4.3 anyOf shape", () => {
  it("zod itself now emits a type list (the reason for the rewrite)", () => {
    expect(z.toJSONSchema(z.string().nullable())).toMatchObject({ type: ["string", "null"] });
  });

  it("task.dispatcher and set_web_settings' nullable fields list as anyOf with the description outside", () => {
    expect(tool("task").properties.dispatcher).toEqual({
      description: expect.stringContaining("Who handed the work out"),
      anyOf: [{ type: "string" }, { type: "null" }],
    });
    const branches = tool("set_web_settings").properties.change.oneOf as Array<{ properties: Record<string, any> }>;
    const props = branches.flatMap(b => Object.values(b.properties));
    expect(props.filter(p => Array.isArray(p.type))).toEqual([]);
    const nullable = props.filter(p => Array.isArray(p.anyOf) && p.anyOf.some((b: any) => b.type === "null"));
    expect(nullable.length).toBeGreaterThanOrEqual(4);
    for (const p of nullable) {
      expect(p.anyOf).toHaveLength(2);
      expect(typeof p.anyOf[0].type).toBe("string");
      expect(p.anyOf[1]).toEqual({ type: "null" });
    }
  });
});
