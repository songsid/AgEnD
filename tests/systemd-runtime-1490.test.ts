import { describe, expect, it } from "vitest";
import { readSystemdRuntime, systemdRunning, systemdStopped } from "../src/systemd-runtime.js";
import type { CommandResult } from "../src/update-install.js";

function bus(changed: Record<string, unknown> = {}, fault?: { name: string; result: Partial<CommandResult> }) {
  const fields: Record<string, [string, unknown]> = { LoadUnit: ["o", ["/org/freedesktop/systemd1/unit/private"]],
    ActiveState: ["s", "inactive"], SubState: ["s", "dead"], Job: ["(uo)", [0, "/"]], MainPID: ["u", 0], ControlPID: ["u", 0],
    Type: ["s", "notify"], KillMode: ["s", "mixed"], SendSIGKILL: ["b", true] };
  return (_command: string, args: string[]): CommandResult => {
    const name = args.includes("LoadUnit") ? "LoadUnit" : args.at(-1)!;
    const [type, data] = fields[name]!;
    return { status: 0, signal: null, stderr: "", stdout: JSON.stringify({ type, data: Object.hasOwn(changed, name) ? changed[name] : data }), ...(fault?.name === name ? fault.result : {}) };
  };
}
describe("authoritative systemd runtime evidence", () => {
  it("accepts stopped and running controls", () => {
    expect(systemdStopped(readSystemdRuntime(bus(), true, "private"))).toBe(true);
    expect(systemdRunning(readSystemdRuntime(bus({ ActiveState: "active", SubState: "running", MainPID: 123 }), false, "private.service"))).toBe(true);
    expect(systemdStopped(readSystemdRuntime(bus({ ActiveState: "failed", SubState: "failed" }), true, "private"))).toBe(true);
  });
  it.each([
    ["MainPID", "0"], ["MainPID", -1], ["MainPID", 0.5], ["ControlPID", null], ["Job", [0, "/not-absent"]],
    ["Job", [1, "/"]], ["Job", [0, "/", "extra"]], ["ActiveState", null], ["SubState", []],
    ["LoadUnit", ["/untrusted"]], ["LoadUnit", ["/org/freedesktop/systemd1/unit/private", "extra"]],
    ["Type", null], ["KillMode", []], ["SendSIGKILL", "true"],
  ])("malformed %s = %j is unknown", (name, value) => {
    const state = readSystemdRuntime(bus({ [name]: value }), true, "private");
    expect(state).toBeNull(); expect(systemdStopped(state)).toBe(false); expect(systemdRunning(state)).toBe(false);
  });
  it.each([
    { status: 1 }, { status: null }, { signal: "SIGTERM" }, { stdout: "invalid json" },
    { stdout: JSON.stringify({ type: "s", data: 0 }) },
  ])("failed, incomplete or wrong-typed read is unknown (%j)", result => {
    expect(readSystemdRuntime(bus({}, { name: "MainPID", result: result as Partial<CommandResult> }), true, "private")).toBeNull();
  });
  it("a native runner exception is unknown", () => {
    expect(readSystemdRuntime(() => { throw new Error("inert process creation failed"); }, true, "private")).toBeNull();
  });
  it.each([
    { ActiveState: "activating", SubState: "auto-restart" }, { ActiveState: "inactive", SubState: "unknown" },
    { MainPID: 123 }, { ControlPID: 123 }, { Job: [9, "/org/freedesktop/systemd1/job/9"] },
  ])("a pending process/job/state is not stopped (%j)", fields => {
    expect(systemdStopped(readSystemdRuntime(bus(fields), true, "private"))).toBe(false);
  });
  it.each([
    { Type: "forking" }, { Type: "oneshot" }, { KillMode: "none" }, { KillMode: "process" }, { SendSIGKILL: false },
  ])("custom tracking/stop semantics require manual recovery (%j)", fields => {
    const state = readSystemdRuntime(bus(fields), true, "private");
    expect(systemdStopped(state)).toBe(false);
    expect(systemdRunning(readSystemdRuntime(bus({ ...fields, ActiveState: "active", SubState: "running", MainPID: 123 }), true, "private"))).toBe(false);
  });
});
