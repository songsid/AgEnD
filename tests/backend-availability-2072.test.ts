/**
 * #2072: the published backend availability snapshot and the `/backend` steps that read it. No CLI, no account and no
 * network: the probes are fakes, and the offline sign-in check reads a scratch home.
 */
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  availabilityState, BackendAvailabilityStore, parseVersion, probeOfflineAuth, versionBelow, AVAILABILITY_STALE_MS,
  type AvailabilityProbes, type AuthState,
} from "../src/backend-availability.js";
import { backendStep, backendUnusable, type BackendCommandDeps } from "../src/backend-command.js";
import { noteResolvedBinary, resolveBinary } from "../src/backend/types.js";

describe("the state of one backend", () => {
  it("only a definite answer makes a backend unusable; unknown stays selectable", () => {
    const s = (installed: boolean | null, version: string | null, auth: AuthState, minVersion: string | null = null) => availabilityState({ installed, version, auth, minVersion });
    expect(s(false, null, "unknown")).toBe("not_installed");
    expect(s(null, null, "unknown")).toBe("unknown");
    expect(s(true, "2.20.9", "valid", "2.21.0")).toBe("too_old");
    expect(s(true, "2.21.0", "valid", "2.21.0")).toBe("usable");
    expect(s(true, null, "valid", "2.21.0")).toBe("usable");          // no version: no too-old claim
    expect(s(true, "1.0.0", "invalid")).toBe("not_signed_in");
    expect(s(true, "1.0.0", "not_required")).toBe("usable");
    expect(s(true, null, "unknown")).toBe("unknown");
    expect(s(true, "1.0.0", "unknown")).toBe("usable");
  });
  it("reads versions out of CLI output and compares them numerically", () => {
    expect(parseVersion("kiro-cli 2.30.1 (abc)")).toBe("2.30.1");
    expect(parseVersion("codex-cli 0.157")).toBe("0.157.0");
    expect(parseVersion("no version here")).toBeNull();
    expect(versionBelow("2.9.0", "2.21.0")).toBe(true);
    expect(versionBelow("2.21.0", "2.21.0")).toBe(false);
  });
});

function fakes(over: Partial<AvailabilityProbes> = {}): { probes: any; max: () => number } {
  let inFlight = 0, maxInFlight = 0;
  const track = <T>(fn: () => Promise<T>) => async () => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); try { await new Promise(r => setTimeout(r, 2)); return await fn(); } finally { inFlight--; } };
  const probes = {
    resolve: vi.fn((b: string) => track(async () => (b === "grok" ? null : `/bin/${b}`))()),
    version: vi.fn((_b: string, _p: string) => track(async () => "2.30.0")()),
    auth: vi.fn(async (_b: string): Promise<AuthState> => "valid"),
    signature: vi.fn(async (b: string) => `sig-${b}`),
    ...over,
  };
  return { probes, max: () => maxInFlight };
}

describe("the store", () => {
  it("probes one backend at a time, and publishes what each answered", async () => {
    const { probes, max } = fakes();
    const store = new BackendAvailabilityStore(["claude-code", "codex", "grok", "kiro-cli"], probes);
    await Promise.all([store.refresh(), store.refresh(["codex"], { force: true })]);
    expect(max()).toBe(1);
    expect(store.get("grok")!.state).toBe("not_installed");
    expect(store.get("codex")).toMatchObject({ state: "usable", path: "/bin/codex", version: "2.30.0", auth: "valid" });
  });
  it("a pass that finds nothing changed starts no CLI; a change or force does", async () => {
    const { probes } = fakes();
    const store = new BackendAvailabilityStore(["codex"], probes);
    await store.refresh();
    expect(probes.version).toHaveBeenCalledTimes(1);
    await store.refresh();
    expect(probes.version).toHaveBeenCalledTimes(1);            // same binary, same login files: no `--version`
    probes.signature.mockResolvedValue("sig-changed");
    await store.refresh();
    expect(probes.version).toHaveBeenCalledTimes(2);
    await store.refresh(["codex"], { force: true });
    expect(probes.version).toHaveBeenCalledTimes(3);
  });
  it("fails open: a probe that times out or throws keeps the last definite answer", async () => {
    const { probes } = fakes();
    const store = new BackendAvailabilityStore(["codex"], probes);
    await store.refresh();
    expect(store.get("codex")!.state).toBe("usable");
    probes.resolve.mockResolvedValue(undefined);                 // no answer in time
    await store.refresh(["codex"], { force: true });
    expect(store.get("codex")!.state).toBe("usable");
    probes.resolve.mockRejectedValue(new Error("crash"));
    await store.refresh(["codex"], { force: true });
    expect(store.get("codex")!.state).toBe("usable");
    probes.resolve.mockResolvedValue("/bin/codex"); probes.version.mockResolvedValue(null as any);
    await store.refresh(["codex"], { force: true });
    expect(store.get("codex")!.version).toBe("2.30.0");          // the same binary's version is kept
  });
  it("kiro-cli older than the supported minimum is too old, with the minimum named", async () => {
    const { probes } = fakes({ version: vi.fn(async () => "2.9.0") });
    const store = new BackendAvailabilityStore(["kiro-cli"], probes);
    await store.refresh();
    expect(store.get("kiro-cli")).toMatchObject({ state: "too_old", minVersion: "2.21.0" });
  });
  it("a read never probes, not even in the background (a handler must not fork); staleness is the owner's to act on", async () => {
    let now = 0;
    const { probes } = fakes();
    const store = new BackendAvailabilityStore(["codex"], probes, { now: () => now });
    expect(store.snapshot()[0]!.state).toBe("unknown");
    expect(store.get("codex")!.state).toBe("unknown");
    await new Promise(r => setTimeout(r, 20));
    expect(probes.resolve).not.toHaveBeenCalled();
    expect(store.stale()).toBe(true);
    await store.refresh();
    expect(store.stale()).toBe(false);
    now += AVAILABILITY_STALE_MS + 1;
    store.snapshot(); await new Promise(r => setTimeout(r, 20));
    expect(probes.resolve).toHaveBeenCalledTimes(1);
    expect(store.stale()).toBe(true);
  });
});

describe("sign-in, read offline", () => {
  const home = () => mkdtempSync(join(tmpdir(), "avail-home-"));
  const put = (dir: string, rel: string, body = "{\"x\":1}") => { mkdirSync(join(dir, rel, ".."), { recursive: true }); writeFileSync(join(dir, rel), body); };
  it("a stored login or an API key is signed in; none is not, where that is proof", async () => {
    const h = home();
    expect(await probeOfflineAuth("codex", {}, h)).toBe("invalid");
    put(h, ".codex/auth.json");
    expect(await probeOfflineAuth("codex", {}, h)).toBe("valid");
    expect(await probeOfflineAuth("grok", {}, h)).toBe("invalid");
    expect(await probeOfflineAuth("grok", { XAI_API_KEY: "k" }, h)).toBe("valid");
    expect(await probeOfflineAuth("antigravity", {}, h)).toBe("invalid");
    put(h, ".gemini/antigravity-cli/antigravity-oauth-token");
    expect(await probeOfflineAuth("antigravity", {}, h)).toBe("valid");
  });
  it("codex on its own provider needs no login of ours", async () => {
    const h = home();
    put(h, ".codex/config.toml", 'model_provider = "glm"\n[model_providers.glm]\nname = "GLM"\n');
    expect(await probeOfflineAuth("codex", { CODEX_HOME: join(h, ".codex") }, h)).toBe("not_required");
    put(h, ".codex/config.toml", '[profiles.x]\nmodel_provider = "glm"\n');   // only a profile's, not the default
    expect(await probeOfflineAuth("codex", { CODEX_HOME: join(h, ".codex") }, h)).toBe("invalid");
  });
  it("where the CLI has ways we cannot see offline, no file is unknown, never 'signed in'", async () => {
    const h = home();
    expect(await probeOfflineAuth("opencode", {}, h)).toBe("unknown");
    expect(await probeOfflineAuth("muse", {}, h)).toBe("unknown");
    const claude = await probeOfflineAuth("claude-code", {}, h);
    expect(claude).toBe(process.platform === "darwin" ? "unknown" : "invalid");   // macOS keeps it in the Keychain
    put(h, ".claude/.credentials.json");
    expect(await probeOfflineAuth("claude-code", {}, h)).toBe("valid");
  });
});

describe("the /backend steps read the snapshot", () => {
  const tk = (key: string, ...args: string[]) => [key, ...args].join("|");
  const deps = (rows: Array<{ backend: string; state: any; minVersion?: string }>, current = "claude-code"): BackendCommandDeps => ({
    currentBackend: () => current, currentDisplay: () => current, availability: () => rows, models: async () => [], modelKnown: () => false,
    effortLevels: () => [], inherited: () => undefined, modelCompatible: () => true, state: () => ({ running: true, busy: false, status: "running" }), t: tk,
  });
  const rows = [{ backend: "claude-code", state: "usable" }, { backend: "codex", state: "not_signed_in" }, { backend: "kiro-cli", state: "too_old", minVersion: "2.21.0" },
    { backend: "grok", state: "not_installed" }, { backend: "opencode", state: "unknown" }];
  it("every backend is listed; an unusable one says why and is disabled; not checked yet stays selectable", async () => {
    const step = await backendStep(deps(rows), "w", []);
    expect(step.kind === "choose" && step.choices).toEqual([
      { token: "claude-code", label: "✓ claude-code" },
      { token: "codex", label: "codex — backend.reason_not_signed_in", disabled: "backend.reason_not_signed_in" },
      { token: "kiro-cli", label: "kiro-cli — backend.reason_too_old|2.21.0", disabled: "backend.reason_too_old|2.21.0" },
      { token: "grok", label: "grok — backend.reason_not_installed", disabled: "backend.reason_not_installed" },
      { token: "opencode", label: "opencode — backend.reason_unchecked" },
    ]);
  });
  it("choosing an unusable one is refused with its reason (a surface that cannot disable an option)", async () => {
    expect(await backendStep(deps(rows), "w", ["codex"])).toEqual({ kind: "refuse", text: "backend.unusable|codex|backend.reason_not_signed_in" });
    expect(await backendStep(deps(rows), "w", ["kiro-cli"])).toEqual({ kind: "refuse", text: "backend.unusable|kiro-cli|backend.reason_too_old|2.21.0" });
    expect((await backendStep(deps(rows), "w", ["opencode"])).kind).toBe("choose");
  });
  it("fails open: the instance's own backend is never disabled, whatever a probe said", async () => {
    const step = await backendStep(deps(rows, "grok"), "w", []);
    expect(step.kind === "choose" && step.choices.find(c => c.token === "grok")).toEqual({ token: "grok", label: "✓ grok" });
    expect(backendUnusable(tk, { backend: "grok", state: "not_installed" })).toBe("backend.reason_not_installed");
  });
});

describe("a launch on the loop uses the snapshot's path", () => {
  it("resolveBinary answers from a resolved path without looking it up; null forgets it", () => {
    noteResolvedBinary("agend-test-cli-2072", "/opt/x/agend-test-cli-2072");
    expect(resolveBinary("agend-test-cli-2072")).toBe("/opt/x/agend-test-cli-2072");
    expect(resolveBinary("agend-test-cli-2072", ["/nowhere"])).toBe("agend-test-cli-2072");   // explicit dirs: no hint
    noteResolvedBinary("agend-test-cli-2072", null);
    expect(resolveBinary("agend-test-cli-2072", ["/nowhere"])).toBe("agend-test-cli-2072");
  });
});

describe("#2078 review: a probe never lets a CLI change itself or reach a vendor", () => {
  const scratch = () => mkdtempSync(join(tmpdir(), "avail-bin-"));
  it("muse is never started: its version is read from the file its launcher keeps", async () => {
    const { probeBackendVersion } = await import("../src/backend-availability.js");
    const dir = scratch(), marker = join(dir, "ran");
    writeFileSync(join(dir, "muse"), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\necho 9.9.9\n`, { mode: 0o755 });
    writeFileSync(join(dir, ".muse-version"), "1.4.10-R6427.1\n");
    expect(await probeBackendVersion("muse", join(dir, "muse"))).toBe("1.4.10");
    expect(existsSync(marker)).toBe(false);
    expect(await probeBackendVersion("muse", join(scratch(), "muse"))).toBeNull();      // no file: unknown, still not started
  });
  it("`--version` runs with no network and with the no-update switches (null where namespaces are not allowed)", async () => {
    const { probeBackendVersion } = await import("../src/backend-availability.js");
    const dir = scratch();
    // The "version" it prints is its network interface count (/proc/net is per namespace), then DISABLE_AUTOUPDATER:
    // no network = only loopback.
    writeFileSync(join(dir, "fakecli"), '#!/bin/sh\necho "$(tail -n +3 /proc/net/dev | wc -l | tr -d " ").${DISABLE_AUTOUPDATER:-0}.0"\n', { mode: 0o755 });
    const got = await probeBackendVersion("codex", join(dir, "fakecli"));
    expect(got === null || got === "1.1.0").toBe(true);
  });
});

describe("#2078 review: the logins read are the ones the CLI reads", () => {
  const home = () => mkdtempSync(join(tmpdir(), "avail-home2-"));
  const put = (path: string) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, "{\"x\":1}"); };
  it("claude's login is in CLAUDE_CONFIG_DIR when set, not ~/.claude", async () => {
    const h = home(), cfg = join(h, "elsewhere");
    put(join(cfg, ".credentials.json"));
    expect(await probeOfflineAuth("claude-code", { CLAUDE_CONFIG_DIR: cfg }, h)).toBe("valid");
    const h2 = home(); put(join(h2, ".claude", ".credentials.json"));
    expect(await probeOfflineAuth("claude-code", { CLAUDE_CONFIG_DIR: join(h2, "empty") }, h2)).toBe(process.platform === "darwin" ? "unknown" : "invalid");
  });
  it("codex's top-level `profile` selects the provider; an unreadable selection is unknown", async () => {
    const { codexUsesOwnProvider } = await import("../src/backend-availability.js");
    const h = home(), cx = join(h, ".codex"); mkdirSync(cx, { recursive: true });
    const t = async (body: string) => { writeFileSync(join(cx, "config.toml"), body); return codexUsesOwnProvider({ CODEX_HOME: cx }); };
    expect(await t('profile = "glm"\n[profiles.glm]\nmodel_provider = "glm"\n')).toBe("yes");
    expect(await t('profile = "x"\n[profiles.y]\nmodel_provider = "glm"\n')).toBe("unknown");
    expect(await t('profile = "o"\n[profiles.o]\nmodel = "gpt-5"\n')).toBe("no");
    expect(await t('[profiles.x]\nmodel_provider = "glm"\n')).toBe("no");
    expect(await probeOfflineAuth("codex", { CODEX_HOME: cx }, h)).toBe("invalid");   // the last config: no own provider, no login
    await t('profile = "x"\n[profiles.y]\nmodel_provider = "glm"\n');
    expect(await probeOfflineAuth("codex", { CODEX_HOME: cx }, h)).toBe("unknown");
  });
});

describe("#2078 review: the version is read from disk first, starting nothing", () => {
  it("a versioned install path, an npm package.json, else nothing — and no CLI started for any of them", async () => {
    const { staticBackendVersion } = await import("../src/backend-availability.js");
    const { symlinkSync } = await import("node:fs");
    const root = mkdtempSync(join(tmpdir(), "avail-static-")), marker = join(root, "ran");
    const cli = (dir: string) => { mkdirSync(dir, { recursive: true }); const f = join(dir, "cli"); writeFileSync(f, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, { mode: 0o755 }); return f; };
    // claude's layout: a link to …/versions/<version>
    const versions = join(root, "share", "claude", "versions"); mkdirSync(versions, { recursive: true });
    writeFileSync(join(versions, "2.1.302"), "#!/bin/sh\n", { mode: 0o755 });
    symlinkSync(join(versions, "2.1.302"), join(root, "claude"));
    expect(await staticBackendVersion("claude-code", join(root, "claude"))).toBe("2.1.302");
    // codex's layout: …/releases/0.162.1-<target>/bin/codex
    expect(await staticBackendVersion("codex", cli(join(root, "releases", "0.162.1-x86_64-unknown-linux-musl", "bin")))).toBe("0.162.1");
    // an npm-installed CLI: node_modules/<pkg>/bin/cli with package.json beside
    const pkg = join(root, "lib", "node_modules", "some-cli"); mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "some-cli", version: "3.4.5" }));
    expect(await staticBackendVersion("opencode", cli(join(pkg, "bin")))).toBe("3.4.5");
    // under nvm the path carries Node's version: the CLI's package.json wins (Fable R2 witness: 1.7.3, not 22.22.2)
    const nvm = join(root, ".nvm", "versions", "node", "v22.22.2"), grokPkg = join(nvm, "lib", "node_modules", "grok-cli");
    mkdirSync(join(grokPkg, "bin"), { recursive: true }); mkdirSync(join(nvm, "bin"), { recursive: true });
    writeFileSync(join(grokPkg, "package.json"), JSON.stringify({ name: "grok-cli", version: "1.7.3" }));
    writeFileSync(join(grokPkg, "bin", "grok.js"), "#!/bin/sh\n", { mode: 0o755 });
    symlinkSync(join(grokPkg, "bin", "grok.js"), join(nvm, "bin", "grok"));
    expect(await staticBackendVersion("grok", join(nvm, "bin", "grok"))).toBe("1.7.3");
    // a scoped package, and a package.json with no version: unknown, never a path segment
    const scoped = join(nvm, "lib", "node_modules", "@x", "y-cli"); mkdirSync(join(scoped, "bin"), { recursive: true });
    writeFileSync(join(scoped, "package.json"), JSON.stringify({ name: "@x/y-cli", version: "0.9.1" }));
    expect(await staticBackendVersion("opencode", cli(join(scoped, "bin")))).toBe("0.9.1");
    writeFileSync(join(scoped, "package.json"), JSON.stringify({ name: "@x/y-cli" }));
    expect(await staticBackendVersion("opencode", join(scoped, "bin", "cli"))).toBeNull();
    // a version-looking directory that is not a known layout is not a version
    expect(await staticBackendVersion("kiro-cli", cli(join(root, "tools", "2.0.0", "bin")))).toBeNull();
    // nothing on disk says: unknown
    expect(await staticBackendVersion("grok", cli(join(root, "plain", "bin")))).toBeNull();
    expect(existsSync(marker)).toBe(false);
  });
});
