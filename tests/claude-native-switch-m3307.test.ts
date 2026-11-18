/**
 * M-3307 (#4146): the offer to switch an npm-global Claude Code to Claude's native install.
 * - claudeInstallKind reads where the fleet's `claude` really is.
 * - The accounts view offers the switch only on an npm-global install.
 * - The removal command targets the npm copy's own prefix.
 */
import { describe, expect, it } from "vitest";
import { claudeInstallKind, nativeVersionsDir } from "../src/claude-install-kind.js";
import { npmUninstallCommand } from "../src/web-host-install.js";
import { buildAccountsView } from "../src/accounts-view.js";

const HOME = "/home/u";
const NPM = "/usr/lib/node_modules/@anthropic-ai/claude-code";

describe("claudeInstallKind", () => {
  it.each([
    ["the native versions folder", `${HOME}/.local/share/claude/versions/2.1.327`, { kind: "native" }],
    ["npm-global, its bin/claude.exe", `${NPM}/bin/claude.exe`, { kind: "npm-global", npmPackageDir: NPM }],
    ["npm-global, cli.js", `${NPM}/cli.js`, { kind: "npm-global", npmPackageDir: NPM }],
    ["npm-global, the nested platform package's binary", `${NPM}/node_modules/@anthropic-ai/claude-code-linux-x64/claude`, { kind: "npm-global", npmPackageDir: NPM }],
    ["nvm's prefix", `${HOME}/.nvm/versions/node/v22.22.2/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe`, { kind: "npm-global", npmPackageDir: `${HOME}/.nvm/versions/node/v22.22.2/lib/node_modules/@anthropic-ai/claude-code` }],
    ["a top-level platform package is not this package", "/usr/lib/node_modules/@anthropic-ai/claude-code-linux-x64/claude", { kind: "other" }],
    ["Homebrew", "/opt/homebrew/Caskroom/claude-code/2.1.327/claude", { kind: "other" }],
    ["a file deeper inside the versions folder", `${HOME}/.local/share/claude/versions/2.1.327/x`, { kind: "other" }],
  ])("%s", (_label, path, want) => {
    expect(claudeInstallKind(path, {}, HOME)).toEqual(want);
  });

  it("no path: other; XDG_DATA_HOME moves the native folder (only an absolute one)", () => {
    expect(claudeInstallKind(null, {}, HOME)).toEqual({ kind: "other" });
    expect(nativeVersionsDir({ XDG_DATA_HOME: "/data" }, HOME)).toBe("/data/claude/versions");
    expect(nativeVersionsDir({ XDG_DATA_HOME: "rel" }, HOME)).toBe(`${HOME}/.local/share/claude/versions`);
    expect(claudeInstallKind("/data/claude/versions/2.1.327", { XDG_DATA_HOME: "/data" }, HOME)).toEqual({ kind: "native" });
  });
});

describe("npmUninstallCommand", () => {
  it("removes the package with npm aimed at that copy's own prefix", () => {
    expect(npmUninstallCommand(NPM)).toBe("npm --prefix '/usr' -g uninstall @anthropic-ai/claude-code");
    expect(npmUninstallCommand(`${HOME}/.nvm/versions/node/v22.22.2/lib/node_modules/@anthropic-ai/claude-code`)).toBe(`npm --prefix '${HOME}/.nvm/versions/node/v22.22.2' -g uninstall @anthropic-ai/claude-code`);
  });
  it("a prefix with a quote stays one shell word", () => {
    expect(npmUninstallCommand("/o'p/lib/node_modules/@anthropic-ai/claude-code")).toBe("npm --prefix '/o'\\''p' -g uninstall @anthropic-ai/claude-code");
  });
});

describe("the accounts view offers the switch", () => {
  const input = (claudeInstall: unknown) => ({
    targets: [{ backend: "claude-code", profile: null, state: "signed_in", signIn: true }],
    diskProfiles: new Map(), agents: [], classic: [], fleetDefaults: new Map(), claudeInstall,
  }) as any;
  const host = (v: ReturnType<typeof buildAccountsView>) => v.clis.find(c => c.backend === "claude-code")!.rows.find(r => r.scope.kind === "host" && r.profile === null)!;

  it("npm-global: the host row carries nativeSwitch with the package directory", () => {
    expect(host(buildAccountsView(input({ kind: "npm-global", npmPackageDir: NPM }))).nativeSwitch).toEqual({ npmPackageDir: NPM });
  });
  it.each([["native", { kind: "native" }], ["other", { kind: "other" }], ["not read", null]])("%s: no offer", (_l, ci) => {
    expect(host(buildAccountsView(input(ci))).nativeSwitch).toBeUndefined();
  });
});

import { deriveNeedsYou } from "../src/needs-you.js";
import { setLocale, t } from "../src/locale.js";
describe("Needs you: an npm-global Claude Code", () => {
  it("one backend item naming the npm copy; none when it is not npm", () => {
    const base = { prompts: [], instances: [], deliveries: [], ownerOf: () => undefined } as any;
    expect(deriveNeedsYou({ ...base, claudeNpm: { path: NPM, since: 7 } })).toEqual([expect.objectContaining({ id: "claude-npm:7", type: "backend", reason: "claude_npm_install", detail: NPM, since: 7 })]);
    expect(deriveNeedsYou({ ...base, claudeNpm: null })).toEqual([]);
  });
  it("its words, en and zh-TW, point at AI accounts", () => {
    expect(t("needs.reason.claude_npm_install")).toContain("AI accounts");
    setLocale("zh-TW");
    expect(t("needs.reason.claude_npm_install")).toContain("AI 帳號");
    setLocale("en");
  });
});
