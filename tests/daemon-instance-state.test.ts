import { describe, expect, it } from "vitest";
import { PaneStateMachine } from "../src/daemon.js";

describe("PaneStateMachine", () => {
  const timeoutMs = 10 * 60_000;

  it("reports idle when the backend ready prompt is visible", () => {
    const machine = new PaneStateMachine(/READY/, timeoutMs, 0);

    expect(machine.observe("completed output\nREADY", 1).state).toBe("idle");
  });

  it("reports working while non-ready pane content is changing", () => {
    const machine = new PaneStateMachine(/READY/, timeoutMs, 0);

    expect(machine.observe("thinking frame 1", 1).state).toBe("working");
    expect(machine.observe("thinking frame 2", timeoutMs + 1).state).toBe("working");
    expect(machine.snapshot(timeoutMs * 2).unchangedForMs).toBe(timeoutMs - 1);
  });

  it("reports working when output changes behind a persistent ready marker", () => {
    const machine = new PaneStateMachine(/READY/, timeoutMs, 0);

    expect(machine.observe("READY\noutput 1", 1).state).toBe("idle");
    expect(machine.observe("READY\noutput 2", 2).state).toBe("working");
    expect(machine.observe("READY\noutput 2", 3).state).toBe("idle");
  });

  it("reports stuck after a non-ready pane stops changing for the timeout", () => {
    const machine = new PaneStateMachine(/READY/, timeoutMs, 0);

    expect(machine.observe("thinking", 1).state).toBe("working");
    expect(machine.observe("thinking", timeoutMs).state).toBe("working");
    expect(machine.observe("thinking", timeoutMs + 1).state).toBe("stuck");
  });

  it("recovers from stuck when output progresses or the prompt returns", () => {
    const machine = new PaneStateMachine(/READY/, timeoutMs, 0);

    machine.observe("thinking", 1);
    expect(machine.observe("thinking", timeoutMs + 1).state).toBe("stuck");
    expect(machine.observe("new output", timeoutMs + 2).state).toBe("working");
    expect(machine.observe("new output\nREADY", timeoutMs + 3).state).toBe("working");
    expect(machine.observe("new output\nREADY", timeoutMs + 4).state).toBe("idle");
  });

  it("handles global ready regexes deterministically", () => {
    const machine = new PaneStateMachine(/READY/g, timeoutMs, 0);

    expect(machine.observe("READY", 1).state).toBe("idle");
    expect(machine.observe("READY", 2).state).toBe("idle");
  });
});
