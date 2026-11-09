/**
 * The values the registry (src/cli-registry.ts) feeds into the rest of AgEnD, written out LITERALLY. They are what each list was before the lists were
 * derived from the registry, so these tests are the proof that moving them changed nothing, and they are the second place a reviewer sees when one of them is
 * edited. The ones that decide what a Runtime starts or what the dashboard may run (sign-in commands, environment variable names, probes, binary names, the
 * login flows' safety flags) must stay literal here: if they were derived from the registry too, editing the registry would change them silently.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CLI_IDS } from "../src/cli-capability.js";
import { FIRST_RUN_BACKENDS, capsOf } from "/ui/js/cli-caps.js";
import { SIGN_OUT_CLIS } from "/ui/js/accounts-manage.js";
import { installerSignInBackends } from "/ui/js/backend-signin.js";
import { INSTALL_CLIS } from "/ui/js/runtime-cli-install.js";
import { hostFacts, hostIds, hostIdsByRank, runtimeFacts, runtimeIds, runtimeProviderIds } from "../src/cli-registry.js";
import { ACCOUNT_CLIS, MACHINE_ACCOUNT_CLIS, PROFILE_CLIS } from "../src/accounts-view.js";
import { SIGN_OUT } from "../src/accounts-signout.js";
import { ONBOARDING_BACKENDS } from "../src/backend-signin-pending.js";
import { CHAT_PROFILE_LOGIN_BACKENDS, CREDENTIAL_HOMES } from "../src/backend/credential-profile.js";
import { BACKEND_INSTALLATION_INFO } from "../src/instance-lifecycle.js";
import { BACKEND_AUTH_CHECKS, LOGIN_BACKEND_ALIASES, LOGIN_FLOWS, authIdentitySupported } from "../src/login-flows.js";
import { CREDENTIAL_PROFILE_CLIS } from "../src/runtime-credential-profiles.js";
import { INSTALLABLE_CLIS } from "../src/runtime-cli-install.js";
import { RUNTIME_SIGNIN_CLIS } from "../src/runtime-signin-transport.js";
import { KEEPALIVE_BACKENDS } from "../src/signin-keepalive.js";
import { STRUCTURED_SIGNIN_BACKENDS } from "../src/structured-signin.js";
import { usageProviderIdForBackend } from "../src/usage/usage-api.js";
import { defaultUsageProviderIds } from "../src/usage/providers.js";
import { NATIVE_PROVIDER_IDS, nativeProvider, nativeProviderMcpSupported } from "../src/windows-cli-providers.js";

describe("host lists, as they were", () => {
  it("the Accounts page's CLIs, in its order, and which have named accounts, and which have a paired computer's rows", () => {
    expect([...ACCOUNT_CLIS]).toEqual(["claude-code", "codex", "kiro-cli", "antigravity", "grok", "muse"]);
    expect([...PROFILE_CLIS]).toEqual(["claude-code", "codex", "kiro-cli"]);
    expect([...MACHINE_ACCOUNT_CLIS]).toEqual(["claude-code"]);
    expect(hostIdsByRank("accountCard")).toEqual(["claude-code", "codex", "kiro-cli", "antigravity", "grok", "muse"]);
    expect(hostIds("namedAccounts")).toEqual(["claude-code", "codex", "kiro-cli"]);
    expect(runtimeIds("accountRows")).toEqual(["claude-code"]);
  });

  it("chat's /login names", () => {
    expect(LOGIN_BACKEND_ALIASES).toEqual({
      "claude": "claude-code", "claude-code": "claude-code", "codex": "codex", "grok": "grok", "kiro": "kiro-cli", "kiro-cli": "kiro-cli",
      "agy": "antigravity", "antigravity": "antigravity", "opencode": "opencode",
    });
  });

  it("the login flows' safety flags: who may be given a browser terminal or a public link, and who is declined", () => {
    const flags = (id: string) => { const f = LOGIN_FLOWS[id]!; return { noShellEscape: f.noShellEscape ?? false, tunnelOk: f.tunnelOk ?? false, deviceAuth: f.deviceAuth ?? false, remoteLogin: f.remoteLogin ?? null, command: f.command }; };
    expect(Object.keys(LOGIN_FLOWS).sort()).toEqual(["antigravity", "claude-code", "codex", "grok", "kiro-cli"]);
    expect(flags("claude-code")).toEqual({ noShellEscape: true, tunnelOk: true, deviceAuth: false, remoteLogin: null, command: "claude auth login" });
    expect(flags("codex")).toEqual({ noShellEscape: true, tunnelOk: false, deviceAuth: true, remoteLogin: null, command: "codex login --device-auth" });
    expect(flags("kiro-cli")).toEqual({ noShellEscape: true, tunnelOk: true, deviceAuth: false, remoteLogin: null, command: "kiro-cli login" });
    expect(flags("grok")).toEqual({ noShellEscape: true, tunnelOk: false, deviceAuth: true, remoteLogin: null, command: "grok login" });
    expect(flags("antigravity")).toEqual({ noShellEscape: false, tunnelOk: false, deviceAuth: false, remoteLogin: "unsupported", command: "agy" });
  });

  it("the sign-in probes (a status command, run with a short timeout, never a login) and which CLIs name an account", () => {
    const probe = (id: string) => (LOGIN_FLOWS[id]?.authCheck ?? BACKEND_AUTH_CHECKS[id])?.argv ?? null;
    expect(Object.fromEntries(CLI_IDS.map(id => [id, probe(id)]))).toEqual({
      "claude-code": ["claude", "auth", "status"], "codex": ["codex", "login", "status"], "kiro-cli": ["kiro-cli", "whoami", "--format", "json"],
      "antigravity": ["agy", "models"], "grok": ["grok", "models"], "muse": null, "opencode": ["opencode", "auth", "list"],
    });
    expect(Object.fromEntries(CLI_IDS.map(id => [id, hostFacts(id, "authCheck")?.argv ?? null]))).toEqual(Object.fromEntries(CLI_IDS.map(id => [id, probe(id)])));
    expect(CLI_IDS.filter(authIdentitySupported)).toEqual(["claude-code"]);
    expect(hostIds("identity")).toEqual(["claude-code"]);
  });

  it("the structured sign-in's CLIs and exact commands, and the first-run page's", () => {
    expect([...STRUCTURED_SIGNIN_BACKENDS]).toEqual(["kiro-cli", "claude-code", "codex"]);
    expect(hostIdsByRank("structuredSignIn")).toEqual(["kiro-cli", "claude-code", "codex"]);
    expect(Object.fromEntries(hostIdsByRank("structuredSignIn").map(id => [id, hostFacts(id, "structuredSignIn")!.argv]))).toEqual({
      "kiro-cli": ["kiro-cli", "login"], "claude-code": ["claude", "auth", "login"], "codex": ["codex", "login", "--device-auth"],
    });
    expect([...ONBOARDING_BACKENDS]).toEqual(["kiro-cli", "claude-code", "codex", "antigravity"]);
    expect(hostIdsByRank("firstRunSignIn")).toEqual(["kiro-cli", "claude-code", "codex", "antigravity"]);
    expect(hostIdsByRank("firstRunSignIn").filter(id => hostFacts(id, "firstRunSignIn")!.mode === "browser")).toEqual(["kiro-cli", "claude-code", "codex"]);
    expect(hostIdsByRank("firstRunSignIn").filter(id => hostFacts(id, "firstRunSignIn")!.mode === "console")).toEqual(["antigravity"]);
    // #3307 adds the existing /login flow for named Codex/Kiro accounts;
    // structured named-account controls remain Claude-only below.
    expect([...CHAT_PROFILE_LOGIN_BACKENDS]).toEqual(["claude-code", "codex", "kiro-cli"]);
  });

  it("the CLIs' own logout commands, and keep-alive", () => {
    expect(SIGN_OUT).toEqual({
      "claude-code": { binary: "claude", args: ["auth", "logout"] }, "codex": { binary: "codex", args: ["logout"] }, "kiro-cli": { binary: "kiro-cli", args: ["logout"] },
    });
    expect([...KEEPALIVE_BACKENDS]).toEqual(["claude-code", "codex"]);
    expect(hostIds("keepAlive")).toEqual(["claude-code", "codex"]);
  });

  it("named accounts: the variable that relocates each CLI's home, and how", () => {
    expect(Object.fromEntries(Object.entries(CREDENTIAL_HOMES).map(([id, spec]) => [id, { env: spec.env, kind: spec.kind }]))).toEqual({
      "kiro-cli": { env: "XDG_DATA_HOME", kind: "relocate-home" }, "codex": { env: "CODEX_HOME", kind: "redirect-files" }, "claude-code": { env: "CLAUDE_CONFIG_DIR", kind: "relocate-home" },
    });
  });

  it("the install table: binary, command and the unattended form", () => {
    expect(Object.fromEntries(Object.entries(BACKEND_INSTALLATION_INFO).map(([id, i]) => [id, { binary: i.binary, install: i.install, ...(i.unattended ? { unattended: i.unattended } : {}) }]))).toEqual({
      "claude-code": { binary: "claude", install: "curl -fsSL https://claude.ai/install.sh | bash" },
      "kiro-cli": { binary: "kiro-cli", install: "curl -fsSL https://cli.kiro.dev/install | bash" },
      "codex": { binary: "codex", install: "curl -fsSL https://chatgpt.com/codex/install.sh | sh", unattended: "curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh" },
      "opencode": { binary: "opencode", install: "curl -fsSL https://opencode.ai/install | bash" },
      "antigravity": { binary: "agy", install: "curl -fsSL https://antigravity.google/cli/install.sh | bash" },
      "grok": { binary: "grok", install: "curl -fsSL https://x.ai/cli/install.sh | bash" },
      "muse": { binary: "muse", install: 'mkdir -p "$HOME/.local/bin" && curl -fsSL https://api.meta.ai/muse-launcher.sh -o "$HOME/.local/bin/muse" && chmod +x "$HOME/.local/bin/muse" && MUSE_LAUNCHER_INSTALL=1 "$HOME/.local/bin/muse"' },
    });
  });

  it("the usage panel's provider ids, names and order, and which have a row per named account", () => {
    expect(Object.fromEntries(CLI_IDS.map(id => [id, usageProviderIdForBackend(id)]))).toEqual({
      "claude-code": "claude", "codex": "codex", "kiro-cli": "kiro", "antigravity": "antigravity", "grok": "grok", "muse": "muse", "opencode": null,
    });
    expect(hostIdsByRank("usage").map(id => [hostFacts(id, "usage")!.providerId, hostFacts(id, "usage")!.name])).toEqual([
      ["claude", "Claude"], ["codex", "Codex"], ["muse", "Muse"], ["grok", "Grok"], ["kiro", "Kiro"], ["antigravity", "Antigravity"],
    ]);
    expect(hostIds("usage").filter(id => hostFacts(id, "usage")!.profileRows)).toEqual(["claude-code", "codex", "kiro-cli"]);
    expect(defaultUsageProviderIds()).toEqual(["claude", "codex", "muse", "grok", "kiro", "antigravity"]);
  });
});

describe("the Windows Runtime's lists, as they were", () => {
  it("the providers and their order", () => {
    expect([...NATIVE_PROVIDER_IDS]).toEqual(["codex", "claude-code", "antigravity", "grok", "kiro-cli", "opencode", "muse"]);
    expect(runtimeProviderIds()).toEqual(["codex", "claude-code", "antigravity", "grok", "kiro-cli", "opencode", "muse"]);
    expect(CLI_IDS.filter(nativeProviderMcpSupported)).toEqual(["claude-code", "codex"]);
  });

  it("each provider's executable names, probes and execution flags (what a Runtime looks for and may run)", () => {
    const view = (id: typeof NATIVE_PROVIDER_IDS[number]) => { const p = nativeProvider(id); return { binaryNames: p.binaryNames, supports: p.supports, readOnlySupport: p.readOnlySupport, permission: p.permission, promptTransport: p.promptTransport, authProbe: p.authProbe, modelProbe: p.modelProbe, name: p.name, company: p.company }; };
    expect(Object.fromEntries(NATIVE_PROVIDER_IDS.map(id => [id, view(id)]))).toEqual({
      "codex": { binaryNames: ["codex.exe"], supports: { execution: true, resume: true, model: true, mcp: true }, readOnlySupport: true, permission: "os-sandbox", promptTransport: "stdin-text", authProbe: ["login", "status"], modelProbe: null, name: "Codex", company: "OpenAI" },
      "claude-code": { binaryNames: ["claude.exe"], supports: { execution: true, resume: true, model: true, mcp: true }, readOnlySupport: true, permission: "read-tools", promptTransport: "stdin-text", authProbe: ["auth", "status"], modelProbe: null, name: "Claude Code", company: "Anthropic" },
      "antigravity": { binaryNames: ["agy.exe"], supports: { execution: true, resume: true, model: true }, readOnlySupport: false, permission: "native-policy", promptTransport: "stdin-json", authProbe: null, modelProbe: ["models"], name: "Antigravity", company: "Google" },
      "grok": { binaryNames: ["grok.exe"], supports: { execution: true, resume: true, model: true }, readOnlySupport: false, permission: "native-policy", promptTransport: "file", authProbe: null, modelProbe: ["models"], name: "Grok", company: "xAI" },
      "kiro-cli": { binaryNames: ["kiro-cli.exe"], supports: { execution: false, resume: false, model: true }, readOnlySupport: false, permission: "native-policy", promptTransport: "stdin-text", authProbe: null, modelProbe: ["chat", "--list-models", "--format", "json"], name: "Kiro", company: "AWS" },
      "opencode": { binaryNames: ["opencode.exe"], supports: { execution: true, resume: true, model: true }, readOnlySupport: false, permission: "native-policy", promptTransport: "stdin-text", authProbe: null, modelProbe: ["models"], name: "OpenCode", company: "Anomaly" },
      "muse": { binaryNames: ["muse.exe"], supports: { execution: true, resume: true, model: true }, readOnlySupport: false, permission: "native-policy", promptTransport: "file", authProbe: null, modelProbe: null, name: "Muse", company: "Meta" },
    });
    expect(nativeProvider("kiro-cli").reason).toBe("Windows headless execution exists, but this adapter has not verified its terminal JSON event schema yet.");
    expect(NATIVE_PROVIDER_IDS.filter(id => nativeProvider(id).reason)).toEqual(["kiro-cli"]);
  });

  it("each provider's permission wording is unchanged", () => {
    expect(Object.fromEntries(NATIVE_PROVIDER_IDS.map(id => [id, nativeProvider(id).permissionNote]))).toEqual({
      "codex": "Uses Codex's native read-only or workspace-write sandbox. Approval policy is unchanged.",
      "claude-code": "Read-only exposes Read, Glob and Grep only, with MCP disabled; it is a tool restriction, not an OS sandbox. Workspace accepts file edits inside the working directory only. Every other permission request (shell, network, other folders) is denied in headless mode unless Claude Code's own settings already allow it.",
      "antigravity": "Uses the native CLI permission policy. Plan mode and terminal sandboxing do not guarantee read-only workspace access.",
      "grok": "Uses the native CLI permission policy; no blanket approval or sandbox bypass is added.",
      "kiro-cli": "Native Windows Kiro CLI is separate from Kiro IDE. Headless authentication requires KIRO_API_KEY.",
      "opencode": "Uses the native CLI permission policy; no --auto or permission allow override is added.",
      "muse": "Uses the native CLI approval and sandbox policy; no --disable-approval, --yolo or workspace-switch override is added.",
    });
  });

  it("the sign-ins a computer runs for the dashboard, the variable that points a CLI at a profile, and the CLIs the Runtime installs", () => {
    expect(RUNTIME_SIGNIN_CLIS).toEqual({ "claude-code": ["claude", "auth", "login"] });
    expect(Object.isFrozen(RUNTIME_SIGNIN_CLIS)).toBe(true);
    expect(CREDENTIAL_PROFILE_CLIS).toEqual({ "claude-code": "CLAUDE_CONFIG_DIR" });
    expect(Object.keys(INSTALLABLE_CLIS)).toEqual(["claude-code", "codex", "antigravity", "opencode"]);
    expect(runtimeIds("install")).toEqual(["claude-code", "codex", "antigravity", "opencode"]);
    // What each pin vouches for, written out (the page says "Not yet verified by AgEnD" only for `integrity`): the npm CLIs are pinned to audited releases; Antigravity's download is pinned for its
    // integrity only (the vendor serves just its newest build, and the CLI updates itself afterwards — 2026-11-10 decision).
    expect(Object.fromEntries(runtimeIds("install").map(id => [id, [runtimeFacts(id, "install")!.kind, runtimeFacts(id, "install")!.pin]]))).toEqual({
      "claude-code": ["npm", "audited"], "codex": ["npm", "audited"], "antigravity": ["download", "integrity"], "opencode": ["npm", "audited"],
    });
    expect(runtimeIds("signIn")).toEqual(["claude-code"]);
    expect(runtimeFacts("claude-code", "signIn")).toMatchObject({ argv: ["claude", "auth", "login"], profile: "named" });
    expect(runtimeIds("identity")).toEqual(["claude-code"]);
    expect(runtimeIds("usage")).toEqual([]);
  });
});

/** What the dashboard's scripts (src/ui) offered for each CLI before they read src/ui/cli-caps.js: they must offer the same now. */
describe("the dashboard scripts' lists, as they were", () => {
  const ids = (pick: (caps: NonNullable<ReturnType<typeof capsOf>>) => unknown): string[] => CLI_IDS.filter(id => pick(capsOf(id)!));
  const source = (file: string) => readFileSync(new URL(`../src/ui/${file}`, import.meta.url), "utf8");

  it("Sign out is offered for the CLIs that can sign out", () => {
    expect([...SIGN_OUT_CLIS].sort()).toEqual(["claude-code", "codex", "kiro-cli"]);
  });

  it("the structured sign-in controls are used for these CLIs, and for a named account only for these", () => {
    expect(ids(c => c.structuredSignIn).sort()).toEqual(["claude-code", "codex", "kiro-cli"]);
    expect(ids(c => c.structuredNamedSignIn)).toEqual(["claude-code"]);
  });

  it("the first-run page accepts these ids in its address, and no others", () => {
    expect([...FIRST_RUN_BACKENDS]).toEqual(["kiro-cli", "claude-code", "codex", "antigravity"]);
    expect(installerSignInBackends("?backend_signins=kiro-cli,claude-code,codex,antigravity")).toEqual(["kiro-cli", "claude-code", "codex", "antigravity"]);
    for (const refused of ["grok", "muse", "opencode", "toString", "kiro-cli,grok", "kiro-cli,claude-code,codex,antigravity,kiro-cli"]) expect(installerSignInBackends(`?backend_signins=${refused}`), refused).toBeNull();
  });

  it("what a Move between accounts says about the conversation, per CLI", () => {
    expect(Object.fromEntries(CLI_IDS.map(id => [id, capsOf(id)!.carry]))).toEqual({ "claude-code": "carries", "codex": "keeps", "kiro-cli": "handover", "antigravity": null, "grok": null, "muse": null, "opencode": null });
    expect(Object.fromEntries(CLI_IDS.map(id => [id, capsOf(id)!.carry]))).toEqual(Object.fromEntries(CLI_IDS.map(id => [id, hostFacts(id, "namedAccounts")?.carry ?? null])));
  });

  it("an agent's settings offer an account choice for these CLIs, and the Runtime page lists these CLIs to install", () => {
    expect(ids(c => c.namedAccounts)).toEqual(["claude-code", "codex", "kiro-cli"]);
    expect(INSTALL_CLIS).toEqual([{ id: "claude-code", label: "Claude Code" }, { id: "codex", label: "Codex" }, { id: "antigravity", label: "Antigravity" }, { id: "opencode", label: "OpenCode" }]);
  });

  it("asks about a name that is not a CLI and gets nothing, whatever the name", () => {
    for (const name of ["nope", "", "constructor", "__proto__", "toString", undefined, null, 7]) expect(capsOf(name as never), String(name)).toBeNull();
  });

  it("the standalone setup page's script still names the CLIs it labels (it is served alone, so it cannot import the caps)", () => {
    expect(/const NAMES = (\{[^}]*\});/.exec(source("structured-signin.js"))![1]).toBe('{ "kiro-cli": "Kiro", "claude-code": "Claude Code", codex: "Codex", antigravity: "Antigravity" }');
  });
});
