/**
 * AGEND-223: which command `probeBackendVersion` starts. `spawnProbeCommand` is mocked, so no CLI runs and the argv is what is asserted — on any host, including one where
 * `unshare -rn` works (the real-run tests in backend-availability-2072 cannot tell the direct run from the namespaced one there).
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawned: Array<{ command: string; args: string[] }> = [];
let output: string | null = "1.5.6";
vi.mock("../src/binary-probe.js", async original => {
  const real = await original<typeof import("../src/binary-probe.js")>();
  return { ...real, spawnProbeCommand: (command: string, args: string[]) => {
    spawned.push({ command, args });
    return { answer: Promise.resolve(output), kill() {}, exited: Promise.resolve() };
  } };
});
import { DIRECT_VERSION_BACKENDS, NO_UPDATE_ENV, probeBackendVersion, VERSION_PROBE_MEMORY } from "../src/backend-availability.js";

const argvOf = (c: { command: string; args: string[] }) => [c.command, ...c.args];
const binary = () => join(mkdtempSync(join(tmpdir(), "avail-argv-223-")), "cli");   // no file: the on-disk readers find nothing
const caps = (netless: boolean, scope = false) => ({ netless: async () => netless, scope: async () => scope });
beforeEach(() => { spawned.length = 0; output = "1.5.6"; });

describe.skipIf(process.platform !== "linux")("AGEND-223: the argv of a --version probe", () => {
  it("agy and grok where no namespace can be made: the CLI itself under `env`, no `unshare`", async () => {
    expect(DIRECT_VERSION_BACKENDS.has("antigravity") && DIRECT_VERSION_BACKENDS.has("grok")).toBe(true);
    for (const backend of ["antigravity", "grok"]) {
      spawned.length = 0;
      const path = binary();
      expect(await probeBackendVersion(backend, path, caps(false))).toBe("1.5.6");
      expect(spawned).toHaveLength(1);
      const argv = argvOf(spawned[0]!);
      expect(argv).not.toContain("unshare");
      expect(argv).not.toContain("systemd-run");
      expect(argv.slice(0, 1 + Object.keys(NO_UPDATE_ENV).length)).toEqual(["env", ...Object.entries(NO_UPDATE_ENV).map(([k, v]) => `${k}=${v}`)]);
      expect(argv.slice(-2)).toEqual([path, "--version"]);
    }
  });
  it("with a memory scope available, the direct run is inside it — still no `unshare`", async () => {
    await probeBackendVersion("grok", binary(), caps(false, true));
    const argv = argvOf(spawned[0]!);
    expect(argv.slice(0, 5)).toEqual(["systemd-run", "--user", "--scope", "-q", "-p"]);
    expect(argv).toContain(`MemoryMax=${VERSION_PROBE_MEMORY}`);
    expect(argv).not.toContain("unshare");
    expect(argv.slice(-2)[1]).toBe("--version");
  });
  it("where a namespace can be made, every backend's run is inside `unshare -rn` (the strict rule is unchanged)", async () => {
    for (const backend of ["antigravity", "grok", "kiro-cli", "opencode"]) {
      spawned.length = 0;
      await probeBackendVersion(backend, binary(), caps(true));
      const argv = argvOf(spawned[0]!);
      expect(argv.slice(0, 3)).toEqual(["unshare", "-rn", "--"]);
    }
  });
  it("any other backend where no namespace can be made: nothing is started", async () => {
    for (const backend of ["kiro-cli", "opencode", "gemini", "codex", "muse"]) expect(await probeBackendVersion(backend, binary(), caps(false))).toBeNull();
    expect(spawned).toEqual([]);
  });
  it("a version already on disk starts nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "avail-argv-223-"));
    writeFileSync(join(dir, ".muse-version"), "1.4.6\n");
    expect(await probeBackendVersion("muse", join(dir, "muse"), caps(false))).toBe("1.4.6");
    expect(spawned).toEqual([]);
  });
});
