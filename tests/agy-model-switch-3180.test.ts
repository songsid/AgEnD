import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { agySwitchCommand, agySupportsInlineModel, agySwitchVerdict } from "../src/backend/agy-model-switch.js";
const models = [
 { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)" },
 { id: "claude-sonnet-5-5-high", label: "Claude Sonnet 5.5 (High)" },
 { id: "claude-sonnet-5-5-low", label: "Claude Sonnet 5.5 (Low)" },
];
const fixture = (version: string, name: string) => readFileSync(join(process.cwd(), "tests/fixtures/agy-model-switch-3180", `${version}-${name}.txt`), "utf8");
describe("agy one-shot model and effort proof", () => {
 it("gates on the oldest retained live-switch contract, keeping older and unknown versions on restart", () => {
   expect(agySupportsInlineModel("1.4.7")).toBe(true); expect(agySupportsInlineModel("1.5.9")).toBe(true);
   for (const v of [null, undefined, "unknown", "1.4.6"]) expect(agySupportsInlineModel(v)).toBe(false);
 });
 it("builds one-token model commands, resolves the launch-equivalent effort variant and never sends labels as extra prompts", () => {
   expect(agySwitchCommand({ model: "Claude Sonnet 5.5 (High)", effort: "low" }, models)).toBe("/model claude-sonnet-5-5-low");
   expect(agySwitchCommand({ model: null, effort: "low" }, models)).toBe("/effort low");
   for (const model of ["bogus", "foo\nhello", "foo prompt", "/model", "a;echo"]) expect(agySwitchCommand({ model, effort: null }, models)).toBeNull();
   expect(agySwitchCommand({ model: null, effort: "high prompt" }, models)).toBeNull();
   expect(agySwitchCommand({ model: "claude-sonnet-5-5-high", effort: "medium" }, models)).toBeNull();
 });
 it.each(["1.4.7", "1.5.9"])("uses fresh CLI answers from the actual %s mock rig", version => {
   const before = fixture(version, "before"), model = fixture(version, "model"), effort = fixture(version, "effort"), refusal = fixture(version, "refused");
   const want = { model: "claude-sonnet-5-5-high", effort: null };
   expect(agySwitchVerdict(want, before, model, models)).toMatchObject({ outcome: "switched", confirmed: true });
   expect(agySwitchVerdict({ model: null, effort: "low" }, model, effort, models)).toMatchObject({ outcome: "switched", shown: "low" });
   expect(agySwitchVerdict(want, effort, refusal, models)).toMatchObject({ outcome: "mismatch" });
   expect(agySwitchVerdict(want, model, model, models)).toBeNull();
   expect(agySwitchVerdict({ model: "gemini-3.8-flash-medium", effort: null }, before, model, models)).toMatchObject({ outcome: "mismatch" });
 });
 it("does not accept an old footer or quoted success as new proof", () => {
   const before = fixture("1.5.9", "model");
   expect(agySwitchVerdict({ model: null, effort: "low" }, before, before + "\n```\n> /effort\n  ⎿  Effort set to low\n```\n", models)).toBeNull();
   expect(agySwitchVerdict({ model: null, effort: "low" }, before, before + "\n> Model set to Claude Sonnet 5.5 (Low)\n", models)).toBeNull();
 });
});
