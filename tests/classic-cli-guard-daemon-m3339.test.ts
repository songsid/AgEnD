/** Daemon policy port only; no lifecycle, Fleet handler, pane or account. */
import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon.js";
import { CLASSIC_RESTRICTED_TOOLS } from "../src/contact-auth-types.js";
import { classicPlanDigest } from "../src/classic-cli-guard.js";
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
function owner(backend = "codex") {
  const root = mkdtempSync(join(tmpdir(), "classic-port-")); roots.push(root);
  const d: any = Object.create(Daemon.prototype);
  Object.assign(d, { name: "sample-room", instanceDir: root, config: { backend }, backend: { binaryName: backend },
    runtimeIdentity: { kind: "classic" }, processStatus: "running" });
  return { d, root };
}
it("never reports unproved backends/native panes as restricted ready", () => {
  for (const backend of ["codex", "grok", "kiro-cli", "muse", "opencode", "antigravity"]) {
    const { d } = owner(backend);
    d.setClassicRestriction({ mode: "restricted", roomTools: { publicRead: true, allowedMcpTools: [] } });
    expect(d.classicNativeGuard()).toMatchObject({ state: "not-covered", backend, reason: "unsupported-backend", impactComplete: false });
    expect(d.classicRestriction.allowedAgendTools).toEqual(CLASSIC_RESTRICTED_TOOLS);
  }
  const { d } = owner("claude-code"); d.nativePaneLifecycle = {};
  d.setClassicRestriction({ mode: "restricted", roomTools: { publicRead: true, allowedMcpTools: [] } });
  expect(d.classicNativeGuard().state).toBe("not-covered");
});
it("invalidates changed or malformed plans, preserves identical plans, and needs a running launch", () => {
  const { d, root } = owner("claude-code"), policy = { mode: "restricted", roomTools: { publicRead: true, allowedMcpTools: [] } };
  d.setClassicRestriction(policy);
  const path = join(root, "classic-cli-guard/current.json"), before = readFileSync(path, "utf8");
  d.setClassicRestriction(policy); expect(readFileSync(path, "utf8")).toBe(before);
  d.setClassicRestriction({ ...policy, roomTools: { ...policy.roomTools, publicRead: false } });
  expect(readFileSync(path, "utf8")).not.toBe(before);
  d.backend.classicNativeGuard = vi.fn(() => ({ state: "ready", backend: "claude-code" }));
  expect(d.classicNativeGuard().state).toBe("ready");
  d.processStatus = "stopped"; expect(d.classicNativeGuard().state).toBe("restart-required");
  d.setClassicRestriction({ mode: "unrecognized" }); expect(d.classicNativeGuard().state).toBe("failed");
});
it("preserves the launch for contact-only revision changes and rejects an overtaken CLI plan", () => {
  const { d, root } = owner("claude-code"), policy = { mode: "restricted", policyRevision: 1, roomTools: { publicRead: true, allowedMcpTools: [] } };
  d.setClassicRestriction(policy);
  const frozen = d.classicRestriction, stamp = classicPlanDigest(frozen), path = join(root, "classic-cli-guard/current.json"), before = readFileSync(path, "utf8");
  d.setClassicRestriction({ ...policy, policyRevision: 2 });
  expect(readFileSync(path, "utf8")).toBe(before);
  expect(d.classicRestriction).toBe(frozen);
  expect(() => d.assertClassicRestrictionLaunch(stamp)).not.toThrow();
  d.setClassicRestriction({ ...policy, policyRevision: 3, roomTools: { publicRead: false, allowedMcpTools: [] } });
  expect(() => d.assertClassicRestrictionLaunch(stamp)).toThrow("policy changed");
  expect(readFileSync(path, "utf8")).not.toBe(before);
  expect(() => d.assertClassicRestrictionLaunch(null)).toThrow("policy changed");
});
it("reports a needed restart when a running room releases its CLI restriction", () => {
  const { d } = owner("claude-code");
  d.setClassicRestriction({ mode: "restricted", roomTools: { publicRead: true, allowedMcpTools: [] } });
  d.setClassicRestriction({ mode: "legacy", roomTools: { publicRead: true, allowedMcpTools: [] } });
  expect(d.classicNativeGuard()).toMatchObject({ state: "restart-required", reason: "stale-policy" });
  const initial = owner("claude-code").d;
  initial.setClassicRestriction({ mode: "legacy", roomTools: { publicRead: true, allowedMcpTools: [] } });
  expect(initial.classicNativeGuard()).toMatchObject({ state: "not-covered", reason: "legacy-mode" });
});
