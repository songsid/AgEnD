/**
 * AGEND-136 (upstream #3521): what the Accounts view carries for an installed host CLI's version (src/accounts-view.ts).
 * Each host default row has the binary probe's version and where it stands against the audited release (`cliUpdate`): `behind` with a dashboard Update where the registry
 * has one, `behind` with no button for a CLI that updates itself, `current`, `newer` ("not verified by AgEnD yet"), `unknown`. A CLI that is not installed has none.
 */
import { describe, expect, it } from "vitest";
import { buildAccountsView, type AccountsInput } from "../src/accounts-view.js";

const input = (versions: Record<string, string | null>, over: Partial<AccountsInput> = {}): AccountsInput => ({
  targets: [
    { backend: "claude-code", state: "usable", signIn: true }, { backend: "codex", state: "usable", signIn: true }, { backend: "kiro-cli", state: "usable", signIn: true },
    { backend: "antigravity", state: "usable", signIn: true }, { backend: "grok", state: "usable", signIn: true }, { backend: "muse", state: "usable", signIn: false },
    { backend: "opencode", state: "usable", signIn: false },
  ],
  diskProfiles: new Map(), agents: [], classic: [], fleetDefaults: new Map(), versions: new Map(Object.entries(versions)), ...over,
});
const hostRow = (view: ReturnType<typeof buildAccountsView>, backend: string) => view.clis.find(c => c.backend === backend)?.rows.find(r => r.scope.kind === "host" && r.profile === null);

describe("the version of an installed CLI against the audited release", () => {
  const view = buildAccountsView(input({
    "claude-code": "2.1.316 (Claude Code)", codex: "codex-cli 0.166.0", "kiro-cli": "kiro-cli 3.1.0", antigravity: "1.3.5", grok: "grok 1.0.99 (abc)", muse: "1.4.12-R6909.1", opencode: null,
  }));
  it("behind, and the registry has an update: a dashboard Update to the audited release", () => {
    expect(hostRow(view, "claude-code")).toMatchObject({ version: "2.1.316", cliUpdate: { state: "behind", installed: "2.1.316", audited: "2.1.318", button: true, via: "dashboard" } });
  });
  it("at the audited release: current, no button", () => {
    expect(hostRow(view, "codex")).toMatchObject({ version: "0.166.0", cliUpdate: { state: "current", audited: "0.166.0", button: false, via: "dashboard" } });
    expect(hostRow(view, "kiro-cli")).toMatchObject({ cliUpdate: { state: "current", button: false } });
  });
  it("newer than anything audited: newer (not verified by AgEnD yet), never a button", () => {
    expect(hostRow(view, "grok")).toMatchObject({ version: "1.0.99", cliUpdate: { state: "newer", audited: "1.0.77", installed: "1.0.99", button: false } });
  });
  it("a CLI that updates itself shows the versions and who updates it, and no button even when behind", () => {
    expect(hostRow(view, "antigravity")).toMatchObject({ cliUpdate: { state: "behind", installed: "1.3.5", audited: "1.3.6", button: false, via: "self" } });
    expect(hostRow(view, "muse")).toMatchObject({ version: "1.4.12", cliUpdate: { state: "behind", audited: "1.4.14", button: false, via: "self" } });
  });
  it("a version the probe could not read: unknown, no button, no version", () => {
    const opencode = hostRow(view, "opencode");
    expect(opencode?.cliUpdate).toMatchObject({ state: "unknown", installed: null, audited: "1.18.34", button: false });
    expect(opencode && "version" in opencode).toBe(false);
  });
  it("a CLI that is not installed has neither; the profile rows never carry one", () => {
    const missing = buildAccountsView(input({ grok: "grok 1.0.70" }, { targets: [{ backend: "grok", state: "not_installed", signIn: false, install: "curl … | bash" }] }));
    expect(hostRow(missing, "grok")?.cliUpdate).toBeUndefined();
    const withProfile = buildAccountsView(input({ "claude-code": "2.1.316" }, { diskProfiles: new Map([["claude-code", [{ profile: "work", state: "usable", signIn: true }]]]) }));
    const rows = withProfile.clis.find(c => c.backend === "claude-code")!.rows;
    expect(rows.filter(r => r.cliUpdate).map(r => r.profile)).toEqual([null]);
  });
  it("without the probe's versions every installed CLI is `unknown`, not `current`", () => {
    const none = buildAccountsView({ ...input({}), versions: undefined });
    expect(hostRow(none, "codex")?.cliUpdate).toMatchObject({ state: "unknown", button: false });
  });
});
