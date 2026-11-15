import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { grokSupportsInlineModel, grokSwitchCommand, grokSwitchVerdict } from "../src/backend/grok-model-switch.js";
const pane = (name: string) => readFileSync(join(process.cwd(), "tests/fixtures/grok-model-switch-3180", `1.0.70-${name}.txt`), "utf8");
describe("Grok one-shot switching", () => {
 it("keeps older and unknown versions on restart", () => {
  expect(grokSupportsInlineModel("1.0.70")).toBe(true); expect(grokSupportsInlineModel("1.0.77")).toBe(true);
  for (const v of [null, undefined, "unknown", "1.0.69"]) expect(grokSupportsInlineModel(v)).toBe(false);
 });
 it("builds one-token commands without prompt or shell syntax", () => {
  expect(grokSwitchCommand({ model: "grok-4", effort: "high" })).toBe("/model grok-4 high");
  expect(grokSwitchCommand({ model: null, effort: "low" })).toBe("/effort low");
  for (const model of ["/model", "a b", "a\nx", "a;echo", "a`cmd`", "-x"]) expect(grokSwitchCommand({ model, effort: "high" })).toBeNull();
  expect(grokSwitchCommand({ model: "grok-4", effort: "ultra" })).toBeNull();
 });
 it("verifies actual model and effort captures, including a transient refusal replacing successes", () => {
  expect(grokSwitchVerdict({ model: "grok-4", effort: "high" }, pane("before"), pane("model"))).toMatchObject({ outcome: "switched" });
  expect(grokSwitchVerdict({ model: null, effort: "low" }, pane("model"), pane("effort"))).toMatchObject({ outcome: "switched" });
  expect(grokSwitchVerdict({ model: "definitely-unknown", effort: null }, pane("effort"), pane("refused"))).toMatchObject({ outcome: "mismatch" });
 });
 it("refuses a stale success, mismatched effort/model and quoted prose", () => {
  const model = pane("model");
  expect(grokSwitchVerdict({ model: "grok-4", effort: "high" }, model, model)).toBeNull();
  expect(grokSwitchVerdict({ model: "grok-4", effort: "low" }, pane("before"), model)).toMatchObject({ outcome: "mismatch" });
  expect(grokSwitchVerdict({ model: "other", effort: "high" }, pane("before"), model)).toMatchObject({ outcome: "mismatch" });
  expect(grokSwitchVerdict({ model: "grok-4", effort: "high" }, model, model + "\n> Switched to grok-4 (high effort)\n")).toBeNull();
  expect(grokSwitchVerdict({ model: "grok-4", effort: "low" }, model, model + "\n```\n     Switched to grok-4 (low effort)\n```\n")).toBeNull();
 });
});
