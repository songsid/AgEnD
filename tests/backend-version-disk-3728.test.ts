/**
 * #3728 (AGEND-223): agy and grok are single-file installs. Where `unshare -rn` is refused (a Docker container, Ubuntu 23.10+/24.04 under AppArmor) neither is ever started for its version
 * (#2078 R2 stays whole); grok's version is read from the file its CLI keeps beside the download, and agy — which records no installed version on disk — is unknown.
 */
import { mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawned: Array<{ command: string; args: string[] }> = [];
vi.mock("../src/binary-probe.js", async original => {
  const real = await original<typeof import("../src/binary-probe.js")>();
  return { ...real, spawnProbeCommand: (command: string, args: string[]) => {
    spawned.push({ command, args });
    return { answer: Promise.resolve(null), kill() {}, exited: Promise.resolve() };   // every command: no answer (`unshare -rn` is refused)
  } };
});
import { probeBackendVersion, staticBackendVersion } from "../src/backend-availability.js";

beforeEach(() => { spawned.length = 0; });

/** A grok home as the installer leaves it: `<home>/downloads/grok-linux-x86_64`, `<home>/bin/grok` linking to it, and (after its first run) `<home>/.metadata_version`. */
function grokHome(version: string | null, opts: { markerAge?: "newer" | "older" } = {}) {
  const home = join(mkdtempSync(join(tmpdir(), "grok-disk-3728-")), ".grok");
  mkdirSync(join(home, "downloads"), { recursive: true }); mkdirSync(join(home, "bin"), { recursive: true });
  const bin = join(home, "downloads", "grok-linux-x86_64");
  writeFileSync(bin, "#!/bin/sh\n", { mode: 0o755 });
  utimesSync(bin, new Date("2026-11-12T05:10:00Z"), new Date("2026-11-12T05:10:00Z"));
  symlinkSync(bin, join(home, "bin", "grok"));
  if (version !== null) {
    const marker = join(home, ".metadata_version");
    writeFileSync(marker, version);
    const t = new Date(opts.markerAge === "older" ? "2026-11-12T04:00:00Z" : "2026-11-12T06:47:00Z");
    utimesSync(marker, t, t);
  }
  return { home, bin, launcher: join(home, "bin", "grok") };
}

describe("#3728: grok's installed version is read from disk, starting nothing", () => {
  it("`.metadata_version` beside the download, reached through the launcher link or the file itself", async () => {
    const g = grokHome("1.0.77");
    expect(await staticBackendVersion("grok", g.launcher)).toBe("1.0.77");
    expect(await staticBackendVersion("grok", g.bin)).toBe("1.0.77");
    expect(await probeBackendVersion("grok", g.launcher)).toBe("1.0.77");
    expect(spawned).toEqual([]);   // read from disk: not even the namespace probe ran
  });
  it("a marker older than the binary says nothing about it (a newer download was put there since): unknown", async () => {
    const g = grokHome("1.0.70", { markerAge: "older" });
    expect(await staticBackendVersion("grok", g.launcher)).toBeNull();
  });
  it("no marker, an empty or non-version marker, or a binary outside a grok home's downloads/: unknown", async () => {
    expect(await staticBackendVersion("grok", grokHome(null).launcher)).toBeNull();
    for (const text of ["", "\n", "latest", "1.0", "grok 1.0.77", "1.0.77-beta"]) expect(await staticBackendVersion("grok", grokHome(text).launcher)).toBeNull();
    const elsewhere = join(mkdtempSync(join(tmpdir(), "grok-disk-3728-")), "grok");
    writeFileSync(elsewhere, "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(join(elsewhere, "..", ".metadata_version"), "9.9.9");
    expect(await staticBackendVersion("grok", elsewhere)).toBeNull();
  });
  it("only grok reads it: the same layout under another backend id is unknown", async () => {
    const g = grokHome("1.0.77");
    for (const backend of ["antigravity", "kiro-cli", "opencode", "gemini"]) expect(await staticBackendVersion(backend, g.launcher)).toBeNull();
  });
});

describe("#3728: where `unshare -rn` is refused, no CLI is started for its version (#2078 R2)", () => {
  it("grok with no readable marker, agy, and every other backend: unknown, and only the namespace check ran", async () => {
    const g = grokHome(null);
    const agyDir = mkdtempSync(join(tmpdir(), "agy-disk-3728-"));
    const agyState = join(agyDir, ".gemini", "antigravity-cli"); mkdirSync(join(agyState, "updater"), { recursive: true });
    writeFileSync(join(agyState, "last_check.timestamp"), "");                                        // what agy 1.5.6 leaves: an empty file…
    writeFileSync(join(agyState, "updater", "update_status.json"), '{"success":true,"message":"Already on the latest version."}');   // …and a status with no version
    const agy = join(agyDir, "agy"); writeFileSync(agy, "#!/bin/sh\n", { mode: 0o755 });
    expect(await probeBackendVersion("grok", g.launcher)).toBeNull();
    for (const backend of ["antigravity", "kiro-cli", "opencode", "gemini", "codex"]) expect(await probeBackendVersion(backend, agy)).toBeNull();
    expect(spawned.every(c => c.command === "unshare")).toBe(true);
    expect(spawned.some(c => c.args.includes("--version") || c.command === "env")).toBe(false);
  });
});
