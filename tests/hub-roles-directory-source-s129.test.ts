/** Exact runtime selector with inert mount boundaries; no listener, directory read or disk state is created. */
import { describe, expect, it, vi } from "vitest";
import { HubRuntime } from "../src/hub/runtime.js";
import type { HubMountedDirectory } from "../src/hub/settings-directory-runtime.js";

function rig() {
  const runtime = new HubRuntime({ home: "/unused-s129-source", log() {} });
  const privateRuntime = runtime as unknown as { mountedDirectory: HubMountedDirectory | null; coldDirectory: HubMountedDirectory | null;
    recoveryDirectory: HubMountedDirectory["decision"] | null; admissionTicket: number; directoryAdmissionTicket: number; stopped: boolean };
  const frame = () => null, directory = {}, administrator = { realm: "corp", objectId: "11111111-1111-4111-8111-111111111111" };
  const decision = { administrationProof: frame } as HubMountedDirectory["decision"];
  const current = vi.fn(() => true);
  const source = vi.fn(() => ({ directory, administrator, image: "c".repeat(64), epoch: 0, decisionProof: frame, current,
    bindPassword: "dummy-service-password", config: { server: "dummy-server" }, groups: [] })) as unknown as HubMountedDirectory["source"];
  const mounted: HubMountedDirectory = { decision, current, source,
    sessions() { throw Error("unused inert session boundary"); }, withDirectoryRead: (_person, work) => work() };
  privateRuntime.mountedDirectory = mounted;
  return { runtime, privateRuntime, mounted, source: vi.mocked(source), current, decision, frame, directory, administrator };
}

describe("S129 runtime directory administration selection", () => {
  it("narrows the current mounted packet and freezes copied identity without copying service credentials", () => {
    const r = rig(), selected = r.runtime.directoryAdministration()!;
    expect(selected).not.toBeNull(); expect(selected.decision).toBe(r.decision);
    expect(selected.source).toEqual({ directory: r.directory, administrator: r.administrator, image: "c".repeat(64), epoch: 0, decisionProof: r.frame });
    expect(selected.source.administrator).not.toBe(r.administrator);
    expect(Object.isFrozen(selected)).toBe(true); expect(Object.isFrozen(selected.source)).toBe(true);
    expect(Object.isFrozen(selected.source.administrator)).toBe(true);
    expect(selected.source).not.toHaveProperty("bindPassword"); expect(selected.source).not.toHaveProperty("config");
  });
  it("never selects a cold-only source even when the ordinary settings getter can use it", () => {
    const r = rig(); r.privateRuntime.mountedDirectory = null; r.privateRuntime.coldDirectory = r.mounted;
    expect(r.runtime.directorySettings()).toBe(r.mounted);
    expect(r.runtime.directoryAdministration()).toBeNull(); expect(r.source).not.toHaveBeenCalled();
  });
  it.each(["off", "held"] as const)("refuses an explicitly %s recovery mount", recoveryMode => {
    const r = rig(); r.privateRuntime.mountedDirectory = { ...r.mounted, recoveryMode };
    expect(r.runtime.directoryAdministration()).toBeNull(); expect(r.source).not.toHaveBeenCalled();
  });
  it.each(["coldDirectory", "recoveryDirectory"] as const)("refuses a different physical participant selected by %s", key => {
    const r = rig(), other = { ...r.decision };
    if (key === "coldDirectory") r.privateRuntime.coldDirectory = { ...r.mounted, decision: other };
    else r.privateRuntime.recoveryDirectory = other;
    expect(r.runtime.directoryAdministration()).toBeNull(); expect(r.source).not.toHaveBeenCalled();
  });
  it("refuses a stopped runtime and an unready current mount", () => {
    const r = rig(); r.privateRuntime.stopped = true;
    expect(r.runtime.directoryAdministration()).toBeNull(); expect(r.source).not.toHaveBeenCalled();
    r.privateRuntime.stopped = false; r.current.mockReturnValue(false);
    expect(r.runtime.directoryAdministration()).toBeNull(); expect(r.source).not.toHaveBeenCalled();
  });
  it.each(["admissionTicket", "directoryAdmissionTicket"] as const)("rechecks %s after a source callback", key => {
    const r = rig(), original = r.source.getMockImplementation()!;
    r.source.mockImplementation(() => { const view = original(); r.privateRuntime[key]++; return view; });
    expect(r.runtime.directoryAdministration()).toBeNull();
  });
  it.each(["mount", "current", "source", "getter"] as const)("refuses a reentrant %s replacement", kind => {
    const r = rig(), original = r.source.getMockImplementation()!;
    r.source.mockImplementation(() => {
      const view = original();
      if (kind === "mount") r.privateRuntime.mountedDirectory = { ...r.mounted };
      else if (kind === "current") r.mounted.current = () => true;
      else if (kind === "source") r.mounted.source = () => view;
      else r.decision.administrationProof = () => null;
      return view;
    });
    expect(r.runtime.directoryAdministration()).toBeNull();
  });
  it("rechecks ownership after the final current callback", () => {
    const r = rig(); r.current.mockImplementationOnce(() => true).mockImplementationOnce(() => {
      r.privateRuntime.admissionTicket++; return true;
    });
    expect(r.runtime.directoryAdministration()).toBeNull();
  });
  it.each(["missing-frame", "foreign-frame", "foreign-current", "throws"] as const)("refuses a %s source", kind => {
    const r = rig(), original = r.source.getMockImplementation()!;
    r.source.mockImplementation(() => {
      if (kind === "throws") throw Error("private failure");
      const view = original();
      return { ...view, ...(kind === "foreign-current" ? { current: () => true } : { decisionProof: kind === "missing-frame" ? undefined : () => null }) };
    });
    expect(r.runtime.directoryAdministration()).toBeNull();
  });
});
