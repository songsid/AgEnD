/**
 * AGEND-136 (upstream #3521): the audited-release ledger (src/cli-audited.ts) and what the Update button derives from it.
 * - An update goes to the newest AUDITED release, never "latest"; the command is the registry's with that release in it, filled on the server.
 * - A CLI at the audited release is "current" (no button); one behind it has the button where the registry has an update, and only the versions where the CLI updates
 *   itself; one newer than anything audited is "not verified by AgEnD yet" (no button).
 * - The Windows pane gate reads the same ledger; the Runtime's pinned installs are audited releases.
 */
import { describe, expect, it } from "vitest";
import { AUDITED_CLI_VERSIONS, AUDITED_RELEASE, AUDITED_VERSION, auditedVersion, cliUpdateView, compareVersions, versionOf } from "../src/cli-audited.js";
import { CLI_IDS } from "../src/cli-capability.js";
import { hostFacts, hostIds, runtimeIds } from "../src/cli-registry.js";
import { hostUpdatePlan } from "../src/web-host-install.js";
import { NATIVE_CLI_AUDITED } from "../src/runtime-pane-native.js";
import { INSTALLABLE_CLIS } from "../src/runtime-cli-install.js";

describe("the ledger", () => {
  it("every CLI has audited releases, each a plain x.y.z (Muse's newest with its build), with no duplicate", () => {
    for (const id of CLI_IDS) {
      const list = AUDITED_CLI_VERSIONS[id];
      expect(list.length, id).toBeGreaterThan(0);
      expect(list.every(v => AUDITED_RELEASE.test(v)), id).toBe(true);
      expect(list.filter(v => !AUDITED_VERSION.test(v)).length, `${id}: only a CLI that ships a build keeps it`).toBe(id === "muse" ? 1 : 0);
      expect(new Set(list).size, id).toBe(list.length);
    }
  });
  it("the newest audited release is the one an update goes to, compared by number (not as text)", () => {
    expect(Object.fromEntries(CLI_IDS.map(id => [id, auditedVersion(id)]))).toEqual({
      // The maintainer-confirmed ledger of 2026-11-09 21:00 (Taipei).
      "claude-code": "2.1.319", "codex": "0.167.0", "kiro-cli": "3.1.0", "antigravity": "1.5.3", "grok": "1.0.77", "muse": "1.4.14-R7309.1", "opencode": "1.19.5",
    });
    expect(compareVersions("2.1.99", "2.1.316")).toBe(-1);
    expect(compareVersions("1.4.14", "1.4.4")).toBe(1);
    expect(compareVersions("0.167.0", "0.167.0")).toBe(0);
    // a build after the x.y.z: numbers one by one, and a release with no build is before the same x.y.z with one
    expect(compareVersions("1.4.14-R7012.1", "1.4.14-R7309.1")).toBe(-1);
    expect(compareVersions("1.4.14-R7309.1", "1.4.14-R7309.1")).toBe(0);
    expect(compareVersions("1.4.14-R7309.2", "1.4.14-R7309.1")).toBe(1);
    expect(compareVersions("1.4.14-R999.1", "1.4.14-R7309.1")).toBe(-1);
    expect(compareVersions("1.4.14", "1.4.14-R7309.1")).toBe(-1);
    expect(compareVersions("1.4.15", "1.4.14-R7309.1")).toBe(1);
    expect(auditedVersion("not-a-cli")).toBeNull();
    expect(auditedVersion("toString")).toBeNull();
  });
  it("the Windows pane gate reads the same ledger", () => {
    expect(NATIVE_CLI_AUDITED.codex).toBe(AUDITED_CLI_VERSIONS.codex);
    expect(NATIVE_CLI_AUDITED["claude-code"]).toBe(AUDITED_CLI_VERSIONS["claude-code"]);
  });
  it("the releases the Runtime installs from its pinned table are audited ones — the newest, so an update on a computer is the pinned install", () => {
    for (const id of runtimeIds("update")) {
      const pin = INSTALLABLE_CLIS[id as keyof typeof INSTALLABLE_CLIS].version;
      expect(AUDITED_CLI_VERSIONS[id], id).toContain(pin);
      expect(pin, id).toBe(auditedVersion(id));
    }
  });
});

describe("reading a version", () => {
  it.each([["codex-cli 0.167.0", "0.167.0"], ["2.1.319 (Claude Code)", "2.1.319"], ["grok 1.0.77 (50ca579fa996)", "1.0.77"], ["1.4.14-R7012.1", "1.4.14-R7012.1"], ["Muse Code 1.4.14-R7309.1", "1.4.14-R7309.1"],
    ["1.4.14-R7309", "1.4.14-R7309"], ["0.167.0-beta.1", "0.167.0"], ["1.4.14-R", "1.4.14"], ["1.4.14-R7309.1.x", "1.4.14-R7309.1"],
    ["1.2.3.4", null], ["v1.2", null], ["", null], [null, null], [42, null], ["1.0.77+", "1.0.77"]] as const)("%j → %j", (printed, version) => {
    expect(versionOf(printed)).toBe(version);
  });
});

describe("where an installed CLI stands", () => {
  it("behind the audited release: the button, where the registry has an update for it", () => {
    expect(cliUpdateView("grok", "grok 1.0.70 (abc)", true)).toEqual({ state: "behind", audited: "1.0.77", installed: "1.0.70", button: true, latest: false });
    expect(cliUpdateView("claude-code", "2.1.316 (Claude Code)", true)).toMatchObject({ state: "behind", audited: "2.1.319", button: true });
  });
  it("behind, but the CLI updates itself (no update in the registry): the versions only, no button", () => {
    expect(cliUpdateView("muse", "1.4.12-R6909.1", false)).toEqual({ state: "behind", audited: "1.4.14-R7309.1", installed: "1.4.12-R6909.1", button: false, latest: false });
    // Muse: the same x.y.z but another build is not the audited release — and it says which, faithfully
    expect(cliUpdateView("muse", "Muse Code 1.4.14-R7012.1", false)).toEqual({ state: "behind", audited: "1.4.14-R7309.1", installed: "1.4.14-R7012.1", button: false, latest: false });
  });
  it("at the audited release: current, no button", () => {
    expect(cliUpdateView("codex", "codex-cli 0.167.0", true)).toEqual({ state: "current", audited: "0.167.0", installed: "0.167.0", button: false, latest: false });
    expect(cliUpdateView("muse", "1.4.14-R7309.1", false)).toEqual({ state: "current", audited: "1.4.14-R7309.1", installed: "1.4.14-R7309.1", button: false, latest: false });
  });
  it("newer than anything audited (a host that updated itself ahead of the ledger): not verified, never a button", () => {
    expect(cliUpdateView("claude-code", "2.1.320 (Claude Code)", true)).toEqual({ state: "newer", audited: "2.1.319", installed: "2.1.320", button: false, latest: false });
    expect(cliUpdateView("opencode", "1.19.6", true)).toMatchObject({ state: "newer", button: false, latest: false });
    expect(cliUpdateView("muse", "1.4.14-R7400.1", false)).toMatchObject({ state: "newer", button: false });
  });
  it("a version that cannot be read: unknown, no button", () => {
    expect(cliUpdateView("grok", "who knows", true)).toEqual({ state: "unknown", audited: "1.0.77", installed: null, button: false, latest: false });
    expect(cliUpdateView("grok", null, true)).toMatchObject({ state: "unknown", button: false });
  });
  // AGEND-153: the named exception goes to the vendor's newest release, so the audited release does not decide whether it is offered — at, below and above it — but a version nobody could read still is not.
  it("the named exception (latest-unaudited) is offered behind, at and above the audited release, and flagged as such", () => {
    expect(cliUpdateView("antigravity", "1.3.5", true, true)).toEqual({ state: "behind", audited: "1.5.3", installed: "1.3.5", button: true, latest: true });
    expect(cliUpdateView("antigravity", "1.5.3", true, true)).toEqual({ state: "current", audited: "1.5.3", installed: "1.5.3", button: true, latest: true });
    expect(cliUpdateView("antigravity", "1.5.4", true, true)).toEqual({ state: "newer", audited: "1.5.3", installed: "1.5.4", button: true, latest: true });
    expect(cliUpdateView("antigravity", "who knows", true, true)).toEqual({ state: "unknown", audited: "1.5.3", installed: null, button: false, latest: true });
  });
  it("`latest` without an update in the registry is nothing: no button, not flagged", () => {
    expect(cliUpdateView("antigravity", "1.3.5", false, true)).toEqual({ state: "behind", audited: "1.5.3", installed: "1.3.5", button: false, latest: false });
  });
  it("an id with no audited release has no reading", () => { expect(cliUpdateView("nonesuch", "1.0.0", true)).toBeNull(); });
});

describe("the update command", () => {
  it("is the registry's, with the newest audited release in it — one plain x.y.z, never `latest`, nothing left to fill", () => {
    for (const id of hostIds("update")) {
      const plan = hostUpdatePlan(id)!;
      expect(plan, id).not.toBeNull();
      if (hostFacts(id, "update")?.release === "latest-unaudited") continue;      // the named exception: the command as written, no release of ours (below)
      expect(plan.target, id).toBe(auditedVersion(id));
      expect(plan.command, id).toContain(plan.target);
      expect(plan.command, id).not.toMatch(/\{|\}|latest|stable/);
    }
    expect(hostUpdatePlan("grok")).toEqual({ command: "curl -fsSL https://x.ai/cli/install.sh | bash -s 1.0.77", target: "1.0.77" });
    expect(hostUpdatePlan("claude-code")!.command).toBe("curl -fsSL https://claude.ai/install.sh | bash -s 2.1.319");
    expect(hostUpdatePlan("codex")!.command).toBe("curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh -s -- --release 0.167.0");
    expect(hostUpdatePlan("kiro-cli")!.command).toBe("curl -fsSL https://cli.kiro.dev/install | bash -s -- --version 3.1.0 --force");
    expect(hostUpdatePlan("opencode")!.command).toBe("curl -fsSL https://opencode.ai/install | bash -s -- --version 1.19.5");
  });
  it("a CLI that updates itself with no exception, or an id that is not a CLI, has none", () => {
    for (const id of ["muse", "nonesuch", "__proto__", "constructor"]) expect(hostUpdatePlan(id), id).toBeNull();
  });
  it("AGEND-153: Antigravity is the one named exception — the registry's own command as written, no audited release to put in it, `latest-unaudited` in the registry", () => {
    expect(hostUpdatePlan("antigravity")).toEqual({ command: "agy update", target: null });
    expect(hostFacts("antigravity", "update")).toMatchObject({ binary: "agy", command: "agy update", release: "latest-unaudited" });
    // and it is the only one: every other update names its audited release
    expect(hostIds("update").filter(id => hostFacts(id, "update")?.release === "latest-unaudited")).toEqual(["antigravity"]);
  });
});
