/**
 * AGEND-136 (upstream #3521): the audited-release ledger (src/cli-audited.ts) and what the Update button derives from it.
 * - An update goes to the newest AUDITED release, never "latest"; the command is the registry's with that release in it, filled on the server.
 * - A CLI at the audited release is "current" (no button); one behind it has the button where the registry has an update, and only the versions where the CLI updates
 *   itself; one newer than anything audited is "not verified by AgEnD yet" (no button).
 * - The Windows pane gate reads the same ledger; the Runtime's pinned installs are audited releases.
 */
import { describe, expect, it } from "vitest";
import { AUDITED_CLI_VERSIONS, AUDITED_VERSION, auditedVersion, cliUpdateView, compareVersions, versionOf } from "../src/cli-audited.js";
import { CLI_IDS } from "../src/cli-capability.js";
import { hostIds, runtimeIds } from "../src/cli-registry.js";
import { hostUpdatePlan } from "../src/web-host-install.js";
import { NATIVE_CLI_AUDITED } from "../src/runtime-pane-native.js";
import { INSTALLABLE_CLIS } from "../src/runtime-cli-install.js";

describe("the ledger", () => {
  it("every CLI has audited releases, each a plain x.y.z, with no duplicate", () => {
    for (const id of CLI_IDS) {
      const list = AUDITED_CLI_VERSIONS[id];
      expect(list.length, id).toBeGreaterThan(0);
      expect(list.every(v => AUDITED_VERSION.test(v)), id).toBe(true);
      expect(new Set(list).size, id).toBe(list.length);
    }
  });
  it("the newest audited release is the one an update goes to, compared by number (not as text)", () => {
    expect(Object.fromEntries(CLI_IDS.map(id => [id, auditedVersion(id)]))).toEqual({
      "claude-code": "2.1.318", "codex": "0.166.0", "kiro-cli": "3.1.0", "antigravity": "1.3.6", "grok": "1.0.77", "muse": "1.4.14", "opencode": "1.18.34",
    });
    expect(compareVersions("2.1.99", "2.1.316")).toBe(-1);
    expect(compareVersions("1.4.14", "1.4.4")).toBe(1);
    expect(compareVersions("0.166.0", "0.166.0")).toBe(0);
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
  it.each([["codex-cli 0.166.0", "0.166.0"], ["2.1.318 (Claude Code)", "2.1.318"], ["grok 1.0.77 (50ca579fa996)", "1.0.77"], ["1.4.14-R7012.1", "1.4.14"],
    ["1.2.3.4", null], ["v1.2", null], ["", null], [null, null], [42, null], ["1.0.77+", "1.0.77"]] as const)("%j → %j", (printed, version) => {
    expect(versionOf(printed)).toBe(version);
  });
});

describe("where an installed CLI stands", () => {
  it("behind the audited release: the button, where the registry has an update for it", () => {
    expect(cliUpdateView("grok", "grok 1.0.70 (abc)", true)).toEqual({ state: "behind", audited: "1.0.77", installed: "1.0.70", button: true });
    expect(cliUpdateView("claude-code", "2.1.316 (Claude Code)", true)).toMatchObject({ state: "behind", audited: "2.1.318", button: true });
  });
  it("behind, but the CLI updates itself (no update in the registry): the versions only, no button", () => {
    expect(cliUpdateView("antigravity", "1.3.5", false)).toEqual({ state: "behind", audited: "1.3.6", installed: "1.3.5", button: false });
  });
  it("at the audited release: current, no button", () => {
    expect(cliUpdateView("codex", "codex-cli 0.166.0", true)).toEqual({ state: "current", audited: "0.166.0", installed: "0.166.0", button: false });
  });
  it("newer than anything audited (a host that updated itself ahead of the ledger): not verified, never a button", () => {
    expect(cliUpdateView("claude-code", "2.1.319 (Claude Code)", true)).toEqual({ state: "newer", audited: "2.1.318", installed: "2.1.319", button: false });
    expect(cliUpdateView("antigravity", "1.4.2", false)).toMatchObject({ state: "newer", button: false });
  });
  it("a version that cannot be read: unknown, no button", () => {
    expect(cliUpdateView("grok", "who knows", true)).toEqual({ state: "unknown", audited: "1.0.77", installed: null, button: false });
    expect(cliUpdateView("grok", null, true)).toMatchObject({ state: "unknown", button: false });
  });
  it("an id with no audited release has no reading", () => { expect(cliUpdateView("nonesuch", "1.0.0", true)).toBeNull(); });
});

describe("the update command", () => {
  it("is the registry's, with the newest audited release in it — one plain x.y.z, never `latest`, nothing left to fill", () => {
    for (const id of hostIds("update")) {
      const plan = hostUpdatePlan(id)!;
      expect(plan, id).not.toBeNull();
      expect(plan.target, id).toBe(auditedVersion(id));
      expect(plan.command, id).toContain(plan.target);
      expect(plan.command, id).not.toMatch(/\{|\}|latest|stable/);
    }
    expect(hostUpdatePlan("grok")).toEqual({ command: "curl -fsSL https://x.ai/cli/install.sh | bash -s 1.0.77", target: "1.0.77" });
    expect(hostUpdatePlan("claude-code")!.command).toBe("curl -fsSL https://claude.ai/install.sh | bash -s 2.1.318");
    expect(hostUpdatePlan("codex")!.command).toBe("curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh -s -- --release 0.166.0");
    expect(hostUpdatePlan("kiro-cli")!.command).toBe("curl -fsSL https://cli.kiro.dev/install | bash -s -- --version 3.1.0 --force");
    expect(hostUpdatePlan("opencode")!.command).toBe("curl -fsSL https://opencode.ai/install | bash -s -- --version 1.18.34");
  });
  it("a CLI that updates itself, or an id that is not a CLI, has none", () => {
    for (const id of ["antigravity", "muse", "nonesuch", "__proto__", "constructor"]) expect(hostUpdatePlan(id), id).toBeNull();
  });
});
