/**
 * AGEND-250: the fixes for the upstream review of #3771 (Prism, REQUEST_CHANGES), one describe per item. Every positive control sits next to its negative one, and each negative was run against the
 * original head to see it fail. Fixture strings only; no account, no token, no real `agy`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { credentialProfileHome } from "../src/backend/credential-profile.js";
import { createStructuredSignInTransport } from "../src/structured-signin-transport.js";
import { InstanceLifecycle, type LifecycleContext } from "../src/instance-lifecycle.js";
import { setAuthCheckRunnerForTests } from "../src/login-flows.js";

const dirs: string[] = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "agend-250-")); dirs.push(d); return d; };
const savedAgend = process.env.AGEND_HOME, savedGemini = process.env.GEMINI_HOME;
afterEach(() => {
  setAuthCheckRunnerForTests(null);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  if (savedAgend === undefined) delete process.env.AGEND_HOME; else process.env.AGEND_HOME = savedAgend;
  if (savedGemini === undefined) delete process.env.GEMINI_HOME; else process.env.GEMINI_HOME = savedGemini;
});
const TOKEN = "antigravity-oauth-token";
function world(profiles: string[] = ["work"]) {
  const data = scratch(), gemini = join(scratch(), "gemini");
  mkdirSync(join(gemini, "antigravity-cli"), { recursive: true });
  process.env.GEMINI_HOME = gemini; process.env.AGEND_HOME = data;
  const home = (p: string) => credentialProfileHome(data, "antigravity", p);
  for (const p of profiles) mkdirSync(home(p), { recursive: true, mode: 0o700 });
  return { data, gemini, home };
}

describe("P2-1: the post-login isolation proof is this attempt's, not an old token file (host transport)", () => {
  const rig = (w: ReturnType<typeof world>) => {
    const native = { start: async () => {}, capture: async () => "", paneStatus: async () => ({ alive: false, exitCode: 0 }), sendInput: async () => {}, kill: async () => {} };
    return createStructuredSignInTransport({ native: native as never, env: { HOME: "/home/x", PATH: "/usr/bin" }, backend: "antigravity", dataDir: w.data });
  };
  const OLD = "FIXTURE-EXPIRED-NOT-A-TOKEN";
  it("an expired file left in the folder, untouched by the login (pin ignored, login went to the shared store): `isolated: false`, and the old file is still there", async () => {
    const w = world(), file = join(w.home("work"), TOKEN); writeFileSync(file, OLD);
    const t = rig(w); await t.start({ argv: ["agy", "acp", "--login"], profile: "work" }, new AbortController().signal);
    expect(await t.status()).toMatchObject({ alive: false, exitCode: 0, isolated: false });
    expect(readFileSync(file, "utf8")).toBe(OLD);
    await t.close();
  });
  it("a rewrite of the same bytes (a new modification time) is a write by this attempt", async () => {
    const w = world(), file = join(w.home("work"), TOKEN); writeFileSync(file, OLD);
    const t = rig(w); await t.start({ argv: ["agy", "acp", "--login"], profile: "work" }, new AbortController().signal);
    const later = new Date(Date.now() + 5000); writeFileSync(file, OLD); utimesSync(file, later, later);
    expect(await t.status()).toEqual({ alive: false, exitCode: 0 });
    await t.close();
  });
  it("positive controls: no file before and one after; an old file replaced by the login", async () => {
    for (const seed of [false, true]) {
      const w = world(), file = join(w.home("work"), TOKEN); if (seed) writeFileSync(file, OLD);
      const t = rig(w); await t.start({ argv: ["agy", "acp", "--login"], profile: "work" }, new AbortController().signal);
      writeFileSync(file, "FIXTURE-NEW-NOT-A-TOKEN-AT-ALL");
      expect(await t.status()).toEqual({ alive: false, exitCode: 0 });
      await t.close();
    }
  });
  it("no file at all, or a file that is a directory, is still not isolated", async () => {
    const w = world(); const t = rig(w); await t.start({ argv: ["agy", "acp", "--login"], profile: "work" }, new AbortController().signal);
    expect(await t.status()).toMatchObject({ isolated: false });
    mkdirSync(join(w.home("work"), TOKEN));
    expect(await t.status()).toMatchObject({ isolated: false });
    await t.close();
  });
});

describe("P2-2: lifecycle auth verification asks the NAMED folder (env AND args), and keeps accounts apart in its cache", () => {
  /** A fake `agy models`: signed in when the launch is the named account's (its `--app_data_dir <folder>` is in argv) = `named`, or the default's (no folder argument) = `def`. */
  function rig(answer: { def: boolean; named: boolean }) {
    const probes: Array<{ argv: string[]; env: Record<string, string> | undefined }> = [];
    setAuthCheckRunnerForTests(async (argv, _ms, env) => {
      probes.push({ argv: [...argv], env: env && { ...env } });
      const isNamed = argv.includes("--app_data_dir");
      const ok = isNamed ? answer.named : answer.def;
      return ok ? { code: 0, output: "models: fixture" } : { code: 1, output: "Please sign in" };
    });
    const lc = new InstanceLifecycle({ logger: { info() {}, warn() {}, error() {}, debug() {} } } as unknown as LifecycleContext);
    return { lc, probes };
  }
  it("default valid, named invalid: the named agent's check reports invalid (not the default's answer), with the folder argument AND the pin", async () => {
    const w = world(), r = rig({ def: true, named: false });
    expect(await r.lc.verifyBackendAuth("antigravity", "work")).toBe("invalid");
    expect(r.probes).toHaveLength(1);
    const argv = r.probes[0]!.argv, at = argv.indexOf("--app_data_dir");
    expect(at).toBeGreaterThan(0);
    expect(argv[at + 1]).toBe(relative(resolve(homedir(), ".gemini"), w.home("work")));
    expect(r.probes[0]!.env).toMatchObject({ SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 0" });
  });
  it("default invalid, named valid: the named agent is valid, and the default's own check carries neither the folder nor the pin", async () => {
    world(); const r = rig({ def: false, named: true });
    expect(await r.lc.verifyBackendAuth("antigravity", "work")).toBe("valid");
    expect(await r.lc.verifyBackendAuth("antigravity")).toBe("invalid");
    expect(r.probes).toHaveLength(2);
    expect(r.probes[1]!.argv).not.toContain("--app_data_dir"); expect(r.probes[1]!.env?.SSH_CONNECTION).toBeUndefined();
  });
  it("cache key: the two accounts are two probes (each asked once), the same account joins one", async () => {
    world(); const r = rig({ def: true, named: false });
    const answers = await Promise.all([r.lc.verifyBackendAuth("antigravity", "work"), r.lc.verifyBackendAuth("antigravity", "work"), r.lc.verifyBackendAuth("antigravity"), r.lc.verifyBackendAuth("antigravity", "other")]);
    expect(answers).toEqual(["invalid", "invalid", "valid", "invalid"]);
    expect(r.probes.map(p => p.argv.includes("--app_data_dir"))).toEqual([true, false, true]);
  });
  it("claude-code keeps its variable launch (an env and no folder argument)", async () => {
    const w = world();
    const probes: Array<{ argv: string[]; env: Record<string, string> | undefined }> = [];
    setAuthCheckRunnerForTests(async (argv, _ms, env) => { probes.push({ argv: [...argv], env }); return { code: 0, output: '{"loggedIn": true}' }; });
    const lc = new InstanceLifecycle({ logger: { info() {}, warn() {}, error() {}, debug() {} } } as unknown as LifecycleContext);
    await lc.verifyBackendAuth("claude-code", "work");
    expect(probes[0]!.env).toEqual({ CLAUDE_CONFIG_DIR: credentialProfileHome(w.data, "claude-code", "work") });
    expect(probes[0]!.argv).not.toContain("--app_data_dir");
  });
});
