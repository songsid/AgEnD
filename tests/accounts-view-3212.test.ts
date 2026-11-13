/**
 * #3212 PR 1: the Accounts view's data (src/accounts-view.ts).
 * - buildAccountsView: per CLI, the default sign-in and the named profiles — used by an agent, a ClassicBot room or
 *   the fleet default, AND only on disk — each with who uses it, its identity and weekly usage; every row `host`
 *   scope; a CLI without profiles has only its default. A CLI that is not installed is listed with its install (AGEND-133, #3521): see the last tests.
 * - profilesOnDisk: real directories with valid names only (a symlink or a bad name is ignored); none for other CLIs.
 * - the usage a row carries: every pool and every window the account reports (accountUsage; tests/accounts-usage-windows-3212.test.ts).
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAccountsView, profilesOnDisk, type AccountsInput } from "../src/accounts-view.js";

const base: AccountsInput = {
  targets: [
    { backend: "claude-code", state: "usable", signIn: true, identity: { maskedEmail: "ab***@example.com", plan: "max" } },
    { backend: "claude-code", profile: "work", state: "usable", signIn: true, identity: { maskedEmail: "cd***@corp.example", plan: "team" } },
    { backend: "codex", state: "not_signed_in", signIn: true },
    { backend: "kiro-cli", state: "not_installed", signIn: false, install: "curl … | bash" },
    { backend: "grok", state: "usable", signIn: true },
  ],
  diskProfiles: new Map([["claude-code", [{ profile: "personal", state: "not_signed_in", signIn: true }]], ["codex", [{ profile: "team2", state: "usable", signIn: false, hostCommand: "CODEX_HOME=… codex login" }]]]),
  agents: [
    { name: "dev", backend: "claude-code", profile: "work" }, { name: "rev", backend: "claude-code", profile: null },
    { name: "gpt", backend: "codex", profile: "team2" },
  ],
  classic: [{ key: "room1", backend: "claude-code", profile: "work" }],
  fleetDefaults: new Map(),
  usage: new Map([["claude-code\0work", { groups: [{ windows: [{ kind: "weekly" as const, percent: 82, resetsAt: "2026-11-09T12:00:00Z", windowMs: 7 * 86400000 }] }] }]]),
};

describe("buildAccountsView", () => {
  it("the default and every named profile (used or only on disk), who uses each, identity and weekly usage — host scope", () => {
    const v = buildAccountsView(base);
    expect(v.clis.map((c) => c.backend)).toEqual(["claude-code", "codex", "kiro-cli", "grok"]);   // kiro: not installed, unused — listed to be installed (AGEND-133)
    const claude = v.clis[0]!;
    expect(claude.rows.map((r) => [r.profile, r.state, r.usedBy.agents, r.usedBy.classic, r.usedBy.fleetDefault])).toEqual([
      [null, "usable", ["rev"], [], true], ["personal", "not_signed_in", [], [], false], ["work", "usable", ["dev"], ["room1"], false]]);
    expect(claude.rows.every((r) => r.scope.kind === "host")).toBe(true);
    expect(claude.rows[2]!.identity).toEqual({ maskedEmail: "cd***@corp.example", plan: "team" });
    expect(claude.rows[2]!.usageGroups).toEqual([{ windows: [{ kind: "weekly", percent: 82, resetsAt: "2026-11-09T12:00:00Z", windowMs: 7 * 86400000 }] }]);
    expect(claude.agents).toEqual([{ name: "dev", profile: "work" }, { name: "rev", profile: null }]);
    const codex = v.clis[1]!;
    expect(codex.rows.map((r) => [r.profile, r.signIn, r.hostCommand ?? null])).toEqual([[null, true, null], ["team2", false, "CODEX_HOME=… codex login"]]);
    expect(v.clis[3]!.profiles).toBe(false);
    expect(v.clis[3]!.rows.map((r) => r.profile)).toEqual([null]);
  });
  it("a fleet default profile: it is listed (even if nothing else names it) and marked; the default sign-in is then not", () => {
    const v = buildAccountsView({ ...base, fleetDefaults: new Map([["claude-code", "shared-team"]]) });
    const claude = v.clis[0]!;
    expect(claude.fleetDefault).toBe("shared-team");
    expect(claude.rows.find((r) => r.profile === "shared-team")?.usedBy.fleetDefault).toBe(true);
    expect(claude.rows.find((r) => r.profile === null)?.usedBy.fleetDefault).toBe(false);
  });
  it("a CLI an agent uses is listed even when it is not installed", () => {
    const v = buildAccountsView({ ...base, agents: [...base.agents, { name: "k", backend: "kiro-cli", profile: null }] });
    expect(v.clis.find((c) => c.backend === "kiro-cli")?.installed).toBe(false);
  });
  // AGEND-133 (#3521): the Install button's rows.
  it("a CLI that is not installed is listed with its state and the registry's install (the row the page puts Install on)", () => {
    const kiro = buildAccountsView(base).clis.find((c) => c.backend === "kiro-cli")!;
    expect(kiro.installed).toBe(false);
    expect(kiro.rows).toHaveLength(1);
    expect(kiro.rows[0]).toMatchObject({ scope: { kind: "host" }, profile: null, state: "not_installed", signIn: false, install: "curl … | bash" });
  });
  it("a CLI with no account card (OpenCode) is listed for its install alone: not installed → a card with no sign-in rows; installed → a card only for its version and Update (AGEND-136)", () => {
    const missing = { ...base, targets: [...base.targets, { backend: "opencode", state: "not_installed" as const, signIn: false, install: "curl … | bash" }] };
    const v = buildAccountsView(missing);
    const oc = v.clis.find((c) => c.backend === "opencode")!;
    expect(oc).toMatchObject({ installOnly: true, installed: false, profiles: false });
    expect(oc.rows.map((r) => [r.profile, r.state, !!r.install])).toEqual([[null, "not_installed", true]]);
    expect(v.clis.filter((c) => c.installOnly).map((c) => c.backend)).toEqual(["opencode"]);
    expect(v.clis.at(-1)!.backend).toBe("opencode");                                      // after the account-card CLIs
    const installed = { ...base, targets: [...base.targets, { backend: "opencode", state: "usable" as const, signIn: false }] };
    // AGEND-136: an installed one is listed for the version it has against the audited release (and Update when it is behind), with no sign-in row.
    const listed = buildAccountsView({ ...installed, versions: new Map([["opencode", "1.17.20"]]) }).clis.find((c) => c.backend === "opencode")!;
    expect(listed).toMatchObject({ installOnly: true, installed: true });
    expect(listed.rows).toHaveLength(1);
    expect(listed.rows[0]).toMatchObject({ version: "1.17.20", cliUpdate: { state: "behind", audited: "1.19.5", installed: "1.17.20", button: true, via: "dashboard" } });
    expect(buildAccountsView({ ...installed, installShown: "opencode" }).clis.find((c) => c.backend === "opencode")).toMatchObject({ installOnly: true, installed: true });
  });
  it("an installed CLI keeps its card while its install is shown (the verdict stays beside it)", () => {
    const shown = buildAccountsView({ ...base, targets: base.targets.map((t) => (t.backend === "kiro-cli" ? { ...t, state: "not_signed_in" as const, signIn: true, install: undefined } : t)), installShown: "kiro-cli" });
    expect(shown.clis.find((c) => c.backend === "kiro-cli")).toMatchObject({ installed: true });
  });
});

const dir = mkdtempSync(join(tmpdir(), "agend-accounts-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
describe("profilesOnDisk", () => {
  it("real directories with valid names; a symlink, a file or a bad name is ignored; none for a CLI without profiles", () => {
    const root = join(dir, "credential-profiles", "claude-code");
    mkdirSync(join(root, "work"), { recursive: true }); mkdirSync(join(root, "personal")); mkdirSync(join(root, ".hidden"));
    mkdirSync(join(dir, "elsewhere")); symlinkSync(join(dir, "elsewhere"), join(root, "linked"));
    writeFileSync(join(root, "afile"), "x");
    expect(profilesOnDisk(dir, "claude-code")).toEqual(["personal", "work"]);
    expect(profilesOnDisk(dir, "codex")).toEqual([]);
    expect(profilesOnDisk(dir, "grok")).toEqual([]);
    const linkedRoot = join(dir, "credential-profiles", "kiro-cli");
    symlinkSync(join(dir, "elsewhere"), linkedRoot);
    expect(profilesOnDisk(dir, "kiro-cli"), "a symlinked root is not followed").toEqual([]);
  });
});
