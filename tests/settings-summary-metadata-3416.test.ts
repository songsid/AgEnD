import { expect, it } from "vitest";
import { copySettingsSummary } from "../src/settings-summary.js";

it("bounds optional display metadata and preserves the underlying rendered record on malformed hints", () => {
  const summary = ["kept verbatim"], descriptor = { v: 1, fallback: summary[0], parts: ["kept verbatim"] } as const;
  expect(copySettingsSummary(summary, [descriptor])).toEqual([descriptor]);
  for (const change of [{ v: 2 }, { fallback: "a different line" }, { parts: [] }, { parts: ["x".repeat(16_385)] }, { parts: [{ key: "x", args: [{}] }] }]) {
    expect(copySettingsSummary(summary, [{ ...descriptor, ...change }] as any)).toBeUndefined();
  }
  expect(summary).toEqual(["kept verbatim"]);
});

