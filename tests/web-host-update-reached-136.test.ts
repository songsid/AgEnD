/**
 * AGEND-136: an update that exits 0 is a success only when the version read afterwards IS the audited release (`reached`); otherwise the run says so (false, or null when the
 * version could not be read) and the page warns with the installed and the audited version. An install never carries it.
 */
import { describe, expect, it, vi } from "vitest";
import { WebHostInstalls, type HostInstallReporter, type HostInstallStart } from "../src/web-host-install.js";

const WHO = { handle: "aaaaaaaaaaaaaaaa", label: "Firefox on Linux" };
function make() {
  const reporters: HostInstallReporter[] = [];
  const start = vi.fn(async (_b: string, r: HostInstallReporter, mode?: string): Promise<HostInstallStart> => { if (mode === "update") r.update?.("1.0.70", "1.0.77"); reporters.push(r); return { started: true }; });
  const installs = new WebHostInstalls({ isLocalAdmin: () => true, installable: () => true, updatable: () => true, start, cancel: async () => true });
  return { installs, reporters };
}
const ok = (version: string | null, verified = true) => ({ ok: true, detail: "clean exit", verified, version, signIn: true });

describe("reached", () => {
  it.each([["1.0.77", true], ["1.0.76", false], ["1.0.70", false], ["grok 1.0.77 (abc)", true], [null, null], ["no number", null]] as const)("an update that ends with %j: reached %j", async (version, reached) => {
    const t = make();
    await t.installs.begin(WHO, "grok", "update");
    t.reporters[0]!.done(ok(version));
    expect(t.installs.view()).toMatchObject({ mode: "update", phase: "ok", fromVersion: "1.0.70", targetVersion: "1.0.77", reached, signIn: false });
  });
  it("a binary that was not found afterwards: not verified, so nothing is claimed (reached null)", async () => {
    const t = make();
    await t.installs.begin(WHO, "grok", "update");
    t.reporters[0]!.done(ok("1.0.77", false));
    expect(t.installs.view()).toMatchObject({ verified: false, reached: null });
  });
  it("a failed update has no verdict on it; an install never has one", async () => {
    const t = make();
    await t.installs.begin(WHO, "grok", "update");
    t.reporters[0]!.done({ ok: false, detail: "CLI exited with code 22 — x", verified: false, version: null, signIn: false });
    expect(t.installs.view()).toMatchObject({ phase: "failed", exitCode: 22, reached: null });
    await t.installs.begin(WHO, "grok");
    t.reporters[1]!.done(ok("1.0.77"));
    expect(t.installs.view()).toMatchObject({ mode: "install", phase: "ok", reached: null, signIn: true });
  });
});
