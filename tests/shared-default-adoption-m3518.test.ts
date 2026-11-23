import { describe, expect, it } from "vitest";
import { SharedDefaultAdoption } from "../src/shared-default-adoption.js";

describe("shared default adoption", () => {
  it("keeps only model/backend deferred through later reloads, preserving unrelated changes", () => {
    const pending = new SharedDefaultAdoption(), owner = {};
    pending.track("agent", owner, { backend: "codex", model: "old" }, { backend: "codex", model: "new" });
    const desired = { backend: "codex", model: "new", working_directory: "/changed", log_level: "debug" };
    expect(pending.view("agent", owner, desired)).toEqual({ config: { ...desired, model: "old" }, deferred: true });
    expect(pending.view("agent", owner, desired).deferred).toBe(true);
    expect(pending.view("agent", {}, desired)).toEqual({ config: desired, deferred: false });
  });
  it("consent covers only that running owner/value; stopped agents never start from this choice", () => {
    const pending = new SharedDefaultAdoption(), owner = {};
    pending.track("agent", owner, { model: "old" }, { model: "new" });
    pending.track("stopped", undefined, { model: "old" }, { model: "new" });
    const consent = pending.consent();
    expect(pending.view("agent", owner, { model: "new" }, consent).deferred).toBe(false);
    expect(pending.view("stopped", undefined, { model: "new" }, consent).deferred).toBe(true);
    pending.track("agent", owner, { model: "old" }, { model: "later" });
    expect(pending.view("agent", owner, { model: "later" }, consent).deferred).toBe(true);
    expect(pending.view("agent", owner, { model: "own-edit" }, consent).deferred).toBe(false);
  });
});

it("R1: consent excludes other pending owners", () => {
  const pending = new SharedDefaultAdoption(), one = {}, two = {};
  pending.track("one", one, { model: "old" }, { model: "new" });
  pending.track("two", two, { model: "old" }, { model: "new" });
  const consent = (pending.consent as any)(new Set(["one"]));
  expect(pending.view("one", one, { model: "new" }, consent).deferred).toBe(false);
  expect(pending.view("two", two, { model: "new" }, consent).deferred).toBe(true);
});
