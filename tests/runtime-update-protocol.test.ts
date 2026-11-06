import { describe, expect, it } from "vitest";
import { parseRuntimeUpdateControl } from "../src/runtime-update-protocol.js";
const base = { v: 1, type: "update.control", id: "11111111-1111-4111-8111-111111111111", bootId: "22222222-2222-4222-8222-222222222222", generation: 3 };
describe("generation-bound Runtime update control", () => {
  it("separates the two directions and returns only bounded identity and phase fields", () => {
    for (const phase of ["prepare", "ready", "cancel", "activate"]) {
      expect(parseRuntimeUpdateControl({ ...base, phase }, "client")).toEqual({ ...base, phase });
      expect(() => parseRuntimeUpdateControl({ ...base, phase }, "server")).toThrow();
    }
    for (const phase of ["prepared", "busy", "commit", "cancelled", "activated"]) {
      expect(parseRuntimeUpdateControl({ ...base, phase }, "server")).toEqual({ ...base, phase });
      expect(() => parseRuntimeUpdateControl({ ...base, phase }, "client")).toThrow();
    }
  });
  it("refuses extra URL/path/authority fields, malformed binding and unknown phases", () => {
    const valid = { ...base, phase: "prepare" };
    for (const input of [null, [], {}, { ...valid, url: "https://other.example.test" }, { ...valid, path: "C:/other" }, { ...valid, admin: true },
      { ...valid, generation: 0 }, { ...valid, generation: 1.2 }, { ...valid, bootId: "previous" }, { ...valid, id: "unbounded" }, { ...valid, phase: "run" }, { ...valid, phase: ["prepare"] }])
      expect(() => parseRuntimeUpdateControl(input, "client")).toThrow();
  });
});
