/**
 * The registry (src/cli-registry.ts) must answer every capability for every CLI, consistently, and every "yes" must be backed by the behaviour it
 * promises. A CLI added without an answer, a "no" without a reason, or a "yes" with nothing behind it fails here. The broken copies below show that the check
 * does catch each of those; tests/cli-registry-golden.test.ts pins the values themselves.
 */
import { describe, expect, it } from "vitest";
import {
  CAPABILITY_PATHS, CLI_IDS, byDesign, notYetBuilt, yes, type Cap, type CliSpec, type HostCapabilities,
} from "../src/cli-capability.js";
import { CLI_SPECS, cliSpec, hostCap, hostFacts, hostIds, hostIdsByRank, isCliId, runtimeFacts, runtimeIds, runtimeProviderIds, type HostCliWith, type RuntimeCliWith } from "../src/cli-registry.js";
import { capabilityOf, checkCliRegistry, cliGaps } from "../src/cli-registry-check.js";
import { ACCOUNT_CLIS, MACHINE_ACCOUNT_CLIS, PROFILE_CLIS } from "../src/accounts-view.js";
import { SIGN_OUT } from "../src/accounts-signout.js";
import { ONBOARDING_BACKENDS } from "../src/backend-signin-pending.js";
import { CHAT_PROFILE_LOGIN_BACKENDS, credentialHomeSpec } from "../src/backend/credential-profile.js";
import { BACKEND_INSTALLATION_INFO } from "../src/instance-lifecycle.js";
import { BACKEND_AUTH_CHECKS, LOGIN_BACKEND_ALIASES, LOGIN_FLOWS, authIdentitySupported } from "../src/login-flows.js";
import { CREDENTIAL_PROFILE_CLIS, isCredentialProfileCli } from "../src/runtime-credential-profiles.js";
import { INSTALLABLE_CLIS, isInstallableCli } from "../src/runtime-cli-install.js";
import { RUNTIME_SIGNIN_CLIS } from "../src/runtime-signin-transport.js";
import { isKeepAliveBackend } from "../src/signin-keepalive.js";
import { STRUCTURED_SIGNIN_BACKENDS, structuredSignInSupported } from "../src/structured-signin.js";
import { usageProviderIdForBackend } from "../src/usage/usage-api.js";
import { defaultUsageProviderIds } from "../src/usage/providers.js";
import { dashboardSignInSupported } from "../src/web-backend-login.js";
import { NATIVE_PROVIDER_IDS, isNativeProviderId, nativeProvider } from "../src/windows-cli-providers.js";

/** A copy anyone can break: the real table is frozen. */
const copy = (): Record<string, any> => structuredClone(CLI_SPECS) as Record<string, any>;

describe("the registry is complete and consistent", () => {
  it("answers every capability of every CLI, with nothing missing, unknown, unexplained or contradictory", () => {
    expect(checkCliRegistry(CLI_SPECS)).toEqual([]);
  });

  it("has a spec for exactly the CLIs in CLI_IDS, each under its own id, deeply frozen", () => {
    expect(Object.keys(CLI_SPECS)).toEqual([...CLI_IDS]);
    for (const id of CLI_IDS) expect(CLI_SPECS[id].id).toBe(id);
    expect(Object.isFrozen(CLI_SPECS)).toBe(true);
    expect(Object.isFrozen(CLI_SPECS.codex.host.install)).toBe(true);
    expect(() => { (CLI_SPECS.codex.host as { keepAlive: unknown }).keepAlive = { support: "no" }; }).toThrow();
    expect(isCliId("codex")).toBe(true);
    expect(isCliId("toString")).toBe(false);
    expect(isCliId("__proto__")).toBe(false);
    expect(cliSpec("nope")).toBeNull();
    expect(hostCap("nope", "install")).toBeNull();
    expect(hostFacts("opencode", "signOut")).toBeNull();
  });

  it("holds plain data only: no function, no RegExp, nothing that is not a string, number, boolean, null or a list or table of them", () => {
    const walk = (value: unknown, where: string): void => {
      if (value === null || ["string", "number", "boolean"].includes(typeof value)) return;
      if (Array.isArray(value)) return value.forEach((v, i) => walk(v, `${where}[${i}]`));
      if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) return Object.entries(value as object).forEach(([k, v]) => walk(v, `${where}.${k}`));
      throw new Error(`${where} is not plain data`);
    };
    walk(CLI_SPECS, "CLI_SPECS");
    expect(JSON.parse(JSON.stringify(CLI_SPECS))).toEqual(CLI_SPECS);
  });

  it("states the gaps, so that a changed answer is seen in review (cli, capability, why, tracking)", () => {
    expect(cliGaps(CLI_SPECS).map(g => `${g.cli} ${g.path} ${g.why}${g.tracking ? ` ${g.tracking}` : ""}`).join("\n")).toBe(`
claude-code runtime.usage not_yet_built undecided
codex host.identity needs_verification
codex runtime.signIn not_yet_built #3212
codex runtime.namedAccounts not_yet_built #3212
codex runtime.accountRows not_yet_built #3212
codex runtime.identity needs_verification
codex runtime.usage not_yet_built undecided
kiro-cli host.identity needs_verification
kiro-cli host.keepAlive needs_verification
kiro-cli runtime.install by_design
kiro-cli runtime.update by_design
kiro-cli runtime.signIn not_yet_built undecided
kiro-cli runtime.namedAccounts not_yet_built undecided
kiro-cli runtime.accountRows not_yet_built undecided
kiro-cli runtime.authStatus not_yet_built undecided
kiro-cli runtime.identity not_applicable
kiro-cli runtime.usage not_yet_built undecided
antigravity host.dashboardSignIn by_design
antigravity host.structuredSignIn not_yet_built undecided
antigravity host.identity not_yet_built undecided
antigravity host.namedAccounts needs_verification
antigravity host.signOut needs_verification
antigravity host.keepAlive needs_verification
antigravity runtime.signIn not_yet_built undecided
antigravity runtime.namedAccounts needs_verification
antigravity runtime.accountRows not_yet_built undecided
antigravity runtime.authStatus not_yet_built undecided
antigravity runtime.identity not_applicable
antigravity runtime.usage not_yet_built undecided
grok host.structuredSignIn not_yet_built undecided
grok host.firstRunSignIn not_yet_built undecided
grok host.identity needs_verification
grok host.namedAccounts needs_verification
grok host.signOut needs_verification
grok host.keepAlive needs_verification
grok runtime.install by_design
grok runtime.update by_design
grok runtime.signIn not_yet_built undecided
grok runtime.namedAccounts needs_verification
grok runtime.accountRows not_yet_built undecided
grok runtime.authStatus not_yet_built undecided
grok runtime.identity not_applicable
grok runtime.usage not_yet_built undecided
muse host.update cli_has_none
muse host.chatLogin cli_has_none
muse host.dashboardSignIn not_applicable
muse host.structuredSignIn not_applicable
muse host.firstRunSignIn not_applicable
muse host.authCheck needs_verification
muse host.identity needs_verification
muse host.namedAccounts needs_verification
muse host.signOut needs_verification
muse host.keepAlive needs_verification
muse runtime.install by_design
muse runtime.update cli_has_none
muse runtime.signIn not_applicable
muse runtime.namedAccounts needs_verification
muse runtime.accountRows not_yet_built undecided
muse runtime.authStatus not_yet_built undecided
muse runtime.identity not_applicable
muse runtime.usage not_yet_built undecided
opencode host.dashboardSignIn not_applicable
opencode host.structuredSignIn not_applicable
opencode host.firstRunSignIn not_applicable
opencode host.identity needs_verification
opencode host.namedAccounts needs_verification
opencode host.signOut needs_verification
opencode host.keepAlive needs_verification
opencode host.accountCard cli_has_none
opencode host.usage cli_has_none
opencode runtime.signIn not_applicable
opencode runtime.namedAccounts needs_verification
opencode runtime.accountRows cli_has_none
opencode runtime.authStatus not_yet_built undecided
opencode runtime.identity not_applicable
opencode runtime.usage cli_has_none`.trimStart());
  });
});

describe("a CLI that leaves something out is caught", () => {
  it("does not compile: a capability left out, or a `not_yet_built` with no issue (checked by `npm run typecheck:tests`)", () => {
    // @ts-expect-error — `usage` is missing: a spec must answer every capability
    const noUsage: CliSpec = { id: "codex", runtime: CLI_SPECS.codex.runtime, host: (({ usage: _usage, ...rest }) => rest)(CLI_SPECS.codex.host) };
    // @ts-expect-error — a "no" must say why
    const noReason: Cap = { support: "no", note: "no reason given at all" };
    // @ts-expect-error — `not_yet_built` must name the issue that tracks it
    const noTracking: Cap = { support: "no", why: "not_yet_built", note: "left for later, with nothing to say when" };
    // @ts-expect-error — a "yes" must carry the facts of its capability (an install has a binary and a command)
    const noFacts: HostCapabilities["install"] = yes();
    expect([noUsage, noReason, noTracking, noFacts]).toHaveLength(4);
  });

  it("the types follow the data: the CLIs that say yes are a type, and a CLI that says no is not one (checked by `npm run typecheck:tests`)", () => {
    const keepAlive: HostCliWith<"keepAlive">[] = ["claude-code", "codex"];
    // @ts-expect-error — Kiro's spec says no to keep-alive, so it is not one of the CLIs that have it
    const notKiro: HostCliWith<"keepAlive"> = "kiro-cli";
    const runtimeInstall: RuntimeCliWith<"install">[] = ["claude-code", "codex", "antigravity", "opencode"];
    // @ts-expect-error — Grok's spec says no to a Runtime install
    const notGrok: RuntimeCliWith<"install"> = "grok";
    expect([keepAlive, notKiro, runtimeInstall, notGrok]).toHaveLength(4);
    expect(keepAlive).toEqual(hostIds("keepAlive"));
    expect(runtimeInstall).toEqual(runtimeIds("install"));
  });

  it("a capability that is not answered", () => {
    const specs = copy();
    delete specs.grok.host.usage;
    delete specs.muse.runtime;
    expect(checkCliRegistry(specs)).toEqual(expect.arrayContaining([
      expect.stringContaining("grok: host.usage is not answered"),
      expect.stringContaining("muse: has no `runtime` capabilities"),
      expect.stringContaining("muse: runtime.provider is not answered"),
    ]));
  });

  it("every capability, left out one at a time, is reported as that capability", () => {
    for (const id of CLI_IDS) for (const path of CAPABILITY_PATHS) {
      const specs = copy(), [group, key] = path.split(".") as ["host" | "runtime", string];
      delete specs[id][group][key];
      expect(checkCliRegistry(specs), `${id} ${path}`).toContainEqual(expect.stringContaining(`${id}: ${path} is not answered`));
    }
  });

  it("a CLI with no spec, a spec for no CLI, a spec under another id, and a capability that does not exist", () => {
    const missing = copy(); delete missing.opencode;
    expect(checkCliRegistry(missing)).toContainEqual("opencode: has no spec");
    const extra = copy(); extra.newcli = structuredClone(extra.codex);
    expect(checkCliRegistry(extra)).toContainEqual("newcli: a spec for a CLI that is not in CLI_IDS");
    const wrong = copy(); wrong.codex.id = "grok";
    expect(checkCliRegistry(wrong)).toContainEqual(expect.stringContaining("codex: its spec says id \"grok\""));
    const typo = copy(); typo.codex.host.keepalive = { support: "yes" };
    expect(checkCliRegistry(typo)).toContainEqual("codex: `host.keepalive` is not a capability");
  });

  it("a \"no\" without a reason, a sentence or the issue that tracks it", () => {
    const specs = copy();
    specs.codex.host.identity = { support: "no" };
    specs.grok.host.signOut = { support: "no", why: "needs_verification", note: "?" };
    specs.muse.host.keepAlive = { support: "no", why: "not_yet_built", note: "left for a later change, no issue yet" };
    specs["kiro-cli"].host.keepAlive = { support: "no", why: "not_yet_built", tracking: "soon", note: "left for a later change, no issue yet" };
    specs.opencode.host.signOut = { support: "no", why: "because", note: "a reason that is not one of the reasons" };
    const problems = checkCliRegistry(specs);
    expect(problems).toContainEqual(expect.stringContaining("codex: host.identity is \"no\" without a reason"));
    expect(problems).toContainEqual(expect.stringContaining("grok: host.signOut is \"no\" (needs_verification) without a sentence saying why"));
    expect(problems).toContainEqual(expect.stringContaining("muse: host.keepAlive is \"not_yet_built\" without the issue that tracks it"));
    expect(problems).toContainEqual(expect.stringContaining("kiro-cli: host.keepAlive is \"not_yet_built\" without the issue that tracks it"));
    expect(problems).toContainEqual(expect.stringContaining("opencode: host.signOut is \"no\" without a reason"));
  });

  it("a \"yes\" without the facts its capability needs, or with a fact it does not know", () => {
    const specs = copy();
    specs.codex.host.install = { support: "yes", binary: "codex" };
    specs.codex.host.signOut = { support: "yes", binary: "codex", args: [] };
    specs.grok.host.usage = { support: "yes", providerId: "grok", name: "Grok", rank: -1, profileRows: "no" };
    specs["claude-code"].host.keepAlive = { support: "yes", every: "day" };
    specs["claude-code"].runtime.provider.modelProbe = undefined;
    specs["claude-code"].runtime.namedAccounts = { support: "yes", env: "claude config dir" };
    const problems = checkCliRegistry(specs);
    expect(problems).toContainEqual("codex: host.install is \"yes\" but has no `command`");
    expect(problems).toContainEqual(expect.stringContaining("codex: host.signOut `args` must be a list of at least one non-empty strings"));
    expect(problems).toContainEqual(expect.stringContaining("grok: host.usage `rank` must be a whole number"));
    expect(problems).toContainEqual(expect.stringContaining("grok: host.usage `profileRows` must be a boolean"));
    expect(problems).toContainEqual("claude-code: host.keepAlive has an unknown field `every`");
    expect(problems).toContainEqual("claude-code: runtime.provider is \"yes\" but has no `modelProbe`");
    expect(problems).toContainEqual(expect.stringContaining("claude-code: runtime.namedAccounts `env` must be an environment variable name"));
  });

  it("two CLIs with the same place in a list, the same usage provider, or an alias that is already taken", () => {
    const specs = copy();
    specs.grok.host.accountCard = yes({ rank: 0 });
    specs.muse.host.usage.providerId = "codex";
    specs.grok.host.chatLogin = yes({ aliases: ["claude", "Agy"], mode: "device-code" });
    specs.codex.host.chatLogin = yes({ aliases: ["grok"], mode: "device-code" });
    const problems = checkCliRegistry(specs);
    expect(problems).toContainEqual(expect.stringContaining("host.accountCard rank: claude-code and grok both have 0"));
    expect(problems).toContainEqual(expect.stringContaining("host.usage providerId: codex and muse both have \"codex\""));
    expect(problems).toContainEqual("grok: the alias \"claude\" is already claude-code's");
    expect(problems).toContainEqual(expect.stringContaining("the alias \"Agy\" must be lower case"));
    expect(problems).toContainEqual("codex: the alias \"grok\" is already grok's");
  });

  it("a capability set up without what it stands on", () => {
    const specs = copy();
    specs["kiro-cli"].host.authCheck = byDesign("taken away to see structured sign-in and identity notice it");
    specs.antigravity.host.keepAlive = yes();                    // keep-alive without named accounts
    specs.grok.host.dashboardSignIn = yes({ named: true });      // named sign-in without named accounts
    specs.grok.host.usage = yes({ providerId: "grok", name: "Grok", rank: 3, profileRows: true });
    specs.codex.runtime.signIn = yes({ argv: ["codex", "login"], profile: "named" });
    specs.codex.runtime.namedAccounts = notYetBuilt("undecided", "taken away to see the Runtime's sign-in notice it");
    specs.codex.runtime.accountRows = yes();
    specs.opencode.runtime.install = yes({ kind: "npm", pin: "audited" });
    specs.opencode.runtime.provider = byDesign("taken away to see the install notice it");
    specs["claude-code"].runtime.namedAccounts = yes({ env: "SOMETHING_ELSE" });
    const problems = checkCliRegistry(specs);
    expect(problems).toContainEqual(expect.stringContaining("kiro-cli: host.structuredSignIn is \"yes\" but host.authCheck is not"));
    expect(problems).toContainEqual(expect.stringContaining("antigravity: host.keepAlive is \"yes\" but host.namedAccounts is not"));
    expect(problems).toContainEqual(expect.stringContaining("grok: host.dashboardSignIn says named accounts can be signed in"));
    expect(problems).toContainEqual(expect.stringContaining("grok: host.usage has rows for named accounts"));
    expect(problems).toContainEqual(expect.stringContaining("codex: runtime.accountRows is \"yes\" but runtime.namedAccounts is not"));
    expect(problems).toContainEqual(expect.stringContaining("codex: runtime.signIn is \"yes\" but runtime.namedAccounts is not"));
    expect(problems).toContainEqual(expect.stringContaining("opencode: runtime.install is \"yes\" but runtime.provider is not"));
    expect(problems).toContainEqual(expect.stringContaining("claude-code: runtime.namedAccounts points at SOMETHING_ELSE, host.namedAccounts at CLAUDE_CONFIG_DIR"));
  });
});

describe("every \"yes\" has the behaviour it promises, every \"no\" has none", () => {
  const ids = [...CLI_IDS];

  it("host.install: the install table has the same binary and commands", () => {
    expect(Object.keys(BACKEND_INSTALLATION_INFO).sort()).toEqual(hostIds("install").sort());
    for (const id of ids) {
      const facts = hostFacts(id, "install"), info = BACKEND_INSTALLATION_INFO[id];
      expect(!!info, id).toBe(!!facts);
      if (facts) expect({ binary: info!.binary, install: info!.install, unattended: info!.unattended }, id).toEqual({ binary: facts.binary, install: facts.command, unattended: facts.unattended });
    }
  });

  it("host.chatLogin: /login knows exactly these names, and what each does follows its login flow", () => {
    const names: Record<string, string> = {};
    for (const id of hostIds("chatLogin")) { names[id] = id; for (const alias of hostFacts(id, "chatLogin")!.aliases) names[alias] = id; }
    expect(LOGIN_BACKEND_ALIASES).toEqual(names);
    for (const id of ids) {
      const facts = hostFacts(id, "chatLogin"), flow = LOGIN_FLOWS[id];
      if (!facts) { expect(flow, id).toBeUndefined(); continue; }
      expect(facts.mode === "install-only" ? flow === undefined : flow !== undefined, id).toBe(true);
      if (facts.mode === "declined") expect(flow!.remoteLogin, id).toBe("unsupported");
      else if (facts.mode !== "install-only") expect(flow!.remoteLogin, id).toBeUndefined();
    }
  });

  it("host.dashboardSignIn and host.structuredSignIn and host.firstRunSignIn: the checks the dashboard asks say the same", () => {
    for (const id of ids) {
      const dash = hostFacts(id, "dashboardSignIn");
      expect(dashboardSignInSupported(id), id).toBe(!!dash);
      expect(dashboardSignInSupported(id, "work"), `${id} named`).toBe(!!dash?.named);
      expect(structuredSignInSupported(id), id).toBe(!!hostFacts(id, "structuredSignIn"));
    }
    expect([...STRUCTURED_SIGNIN_BACKENDS]).toEqual(hostIdsByRank("structuredSignIn"));
    expect([...ONBOARDING_BACKENDS]).toEqual(hostIdsByRank("firstRunSignIn"));
    expect([...CHAT_PROFILE_LOGIN_BACKENDS]).toEqual(ids.filter(id => hostFacts(id, "dashboardSignIn")?.named));
  });

  it("host.authCheck and host.identity: the probe the daemon runs, and the CLIs whose answer names an account", () => {
    for (const id of ids) {
      const probe = LOGIN_FLOWS[id]?.authCheck ?? BACKEND_AUTH_CHECKS[id];
      expect(probe?.argv ?? null, id).toEqual(hostFacts(id, "authCheck")?.argv ?? null);
      expect(authIdentitySupported(id), id).toBe(!!hostFacts(id, "identity"));
    }
  });

  it("host.namedAccounts: the credential homes, and the CLIs that have profiles", () => {
    for (const id of ids) {
      const facts = hostFacts(id, "namedAccounts"), spec = credentialHomeSpec(id);
      expect(!!spec, id).toBe(!!facts);
      if (facts && spec) expect({ env: spec.env, home: spec.kind }, id).toEqual({ env: facts.env, home: facts.home });
    }
    expect([...PROFILE_CLIS]).toEqual(hostIds("namedAccounts"));
  });

  it("host.signOut, host.keepAlive, host.accountCard and host.usage: the same CLIs, in the same order", () => {
    expect(Object.keys(SIGN_OUT)).toEqual(hostIds("signOut"));
    for (const id of ids) {
      expect(isKeepAliveBackend(id), id).toBe(!!hostFacts(id, "keepAlive"));
      const signOut = hostFacts(id, "signOut");
      expect(SIGN_OUT[id] ?? null, id).toEqual(signOut ? { binary: signOut.binary, args: signOut.args } : null);
      expect(usageProviderIdForBackend(id), id).toBe(hostFacts(id, "usage")?.providerId ?? null);
    }
    expect([...ACCOUNT_CLIS]).toEqual(hostIdsByRank("accountCard"));
    // every provider the registry lists has a reader (the usage module refuses to load otherwise), and the panel lists exactly those, in the registry's order
    expect(defaultUsageProviderIds()).toEqual(hostIdsByRank("usage").map(id => hostFacts(id, "usage")!.providerId));
    // the installer's directories (behaviour) exist for every CLI that has an install command
    for (const id of hostIds("install")) expect(typeof BACKEND_INSTALLATION_INFO[id]!.binDirs, id).toBe("function");
  });

  it("runtime.*: the Runtime's own tables list the same CLIs and say the same", () => {
    expect([...NATIVE_PROVIDER_IDS]).toEqual(runtimeProviderIds());
    for (const id of ids) {
      const provider = runtimeFacts(id, "provider"), install = runtimeFacts(id, "install"), signIn = runtimeFacts(id, "signIn"), named = runtimeFacts(id, "namedAccounts"), status = runtimeFacts(id, "authStatus");
      expect(isNativeProviderId(id), id).toBe(!!provider);
      if (provider) {
        const d = nativeProvider(id as typeof NATIVE_PROVIDER_IDS[number]);
        expect({ name: d.name, company: d.company, binaryNames: d.binaryNames, supports: d.supports, readOnlySupport: d.readOnlySupport, permission: d.permission,
          permissionNote: d.permissionNote, promptTransport: d.promptTransport, modelProbe: d.modelProbe, ...(d.reason ? { reason: d.reason } : {}) }, id)
          .toEqual({ name: provider.name, company: provider.company, binaryNames: provider.binaryNames, supports: provider.supports, readOnlySupport: provider.readOnlySupport,
            permission: provider.permission, permissionNote: provider.permissionNote, promptTransport: provider.promptTransport, modelProbe: provider.modelProbe, ...(provider.reason ? { reason: provider.reason } : {}) });
        expect(d.authProbe, id).toEqual(status?.argv ?? null);
      }
      expect(isInstallableCli(id), id).toBe(!!install);
      // The registry says HOW it is installed (a pinned npm package, or one pinned download) and the Runtime's table must be that kind.
      if (install) expect(INSTALLABLE_CLIS[id as keyof typeof INSTALLABLE_CLIS].kind, id).toBe(install.kind);
      expect(RUNTIME_SIGNIN_CLIS[id] ?? null, id).toEqual(signIn?.argv ?? null);
      expect(isCredentialProfileCli(id), id).toBe(!!named);
      if (named) expect(CREDENTIAL_PROFILE_CLIS[id as keyof typeof CREDENTIAL_PROFILE_CLIS], id).toBe(named.env);
      expect(MACHINE_ACCOUNT_CLIS.has(id), id).toBe(runtimeIds("accountRows").includes(id as never));
    }
    expect(Object.keys(INSTALLABLE_CLIS).sort()).toEqual(runtimeIds("install").sort());
  });

  it("every capability address that exists is looked up the same way by the helpers", () => {
    for (const id of ids) for (const path of CAPABILITY_PATHS) {
      const [group, key] = path.split(".") as ["host" | "runtime", string];
      expect(capabilityOf(CLI_SPECS[id], path)).toBe((CLI_SPECS[id][group] as unknown as Record<string, unknown>)[key]);
    }
  });
});
