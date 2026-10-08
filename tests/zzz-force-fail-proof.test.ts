// PROOF COMMIT — deliberately fails to show that a single shard failure makes `build` fail.
// This file is deleted before merging #1392.
import { describe, it, expect } from "vitest";
describe("proof: one shard fails", () => {
  it("deliberately fails — remove before merge", () => {
    expect(true).toBe(false);
  });
});
