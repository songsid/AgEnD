import { describe, expect, it } from "vitest";
import { officeCapturePassed, selectOfficeCaptureCases } from "../scripts/manual/smoke-fixture/office-capture-cases.js";

describe("owned Office capture case guard", () => {
  it("keeps the four default cases and selects the intended exact case", () => {
    expect(selectOfficeCaptureCases()).toHaveLength(4);
    expect(selectOfficeCaptureCases("")).toHaveLength(4);
    expect(selectOfficeCaptureCases("desk-light-en-reduced")).toEqual([
      { device: "desk", theme: "light", lang: "en", rm: true },
    ]);
  });

  it("rejects an unknown selector instead of silently selecting no cases", () => {
    expect(() => selectOfficeCaptureCases("unknown")).toThrow(/unknown.*Office.*case/i);
  });

  it("cannot pass an empty run", () => {
    expect(officeCapturePassed({})).toBe(false);
  });

  it("keeps the exercised pass and failure verdicts", () => {
    expect(officeCapturePassed({ "phone-light-en": {} })).toBe(true);
    expect(officeCapturePassed({ "phone-light-en": { failed: ["mounted"] } })).toBe(false);
  });
});
