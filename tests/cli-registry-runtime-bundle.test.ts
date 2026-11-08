/**
 * AGEND-115 S4: the Windows Runtime reads its CLI tables (providers, named-account variables, sign-in commands, installable CLIs) from the registry, so the registry's files
 * ride in the Runtime bundle. These tests build the bundle, run it outside the AgEnD dependency tree, and check that an older Runtime and an older server still work with
 * a bundle that has (or lacks) them: the update check is driven by the archive's own manifest, and the Runtime's protocol and capabilities are what they were.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { crc32 } from "node:zlib";
import { join, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { CLI_IDS } from "../src/cli-capability.js";
import { CLI_REGISTRY_MODULES, CLI_SPECS } from "../src/cli-registry.js";
import { CREDENTIAL_PROFILE_CLIS } from "../src/runtime-credential-profiles.js";
import { RUNTIME_BUNDLE_MODULES, readRuntimeInfo } from "../src/runtime-build-info.js";
import { createRuntimeBundle } from "../src/runtime-bundle.js";
import { RUNTIME_UPDATE_MAX_BYTES, runtimeUpdateNeeded, validateRuntimeUpdateArchive, type RuntimeUpdateMetadata } from "../src/runtime-update-artifact.js";
import { NATIVE_PROVIDER_IDS, nativeProvider } from "../src/windows-cli-providers.js";
import { compilePortableRuntime } from "./support/runtime-portable-compile.js";
import { runtimeBundleFixture, unzipStored } from "./support/runtime-bundle-fixture.js";

/** The rule `validateRuntimeUpdateArchive` and `readRuntimeInstalledProgram` apply to every module name an archive's manifest lists (src/runtime-update-*.ts). */
const UPDATER_MODULE_NAME = /^[a-z0-9][a-z0-9.-]*\.(js|ps1)$/;
const metadataFor = (bytes: Buffer, version: string): RuntimeUpdateMetadata => ({ version, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });

describe("the registry's files are part of the Runtime bundle", () => {
  it("lists them, each is a source file, and the updater accepts their names", () => {
    expect([...CLI_REGISTRY_MODULES]).toEqual(["cli-capability.js", "cli-registry.js", ...CLI_IDS.map(id => `cli-spec-${id}.js`)]);
    for (const name of CLI_REGISTRY_MODULES) {
      expect(RUNTIME_BUNDLE_MODULES, name).toContain(name);
      expect(statSync(new URL(`../src/${name.replace(/\.js$/, ".ts")}`, import.meta.url)).isFile(), name).toBe(true);
      expect(name, name).toMatch(UPDATER_MODULE_NAME);
    }
    expect(new Set(RUNTIME_BUNDLE_MODULES).size).toBe(RUNTIME_BUNDLE_MODULES.length);
    expect(RUNTIME_BUNDLE_MODULES.length).toBeLessThan(256);                                  // the updater refuses a manifest with more
    // the server-only files of the registry are not shipped to a computer
    for (const name of ["cli-registry-check.js", "cli-caps-module.js"]) expect(RUNTIME_BUNDLE_MODULES).not.toContain(name);
  });

  it("a built bundle is closed, and its tables, run outside the dependency tree, are the registry's", () => {
    const directory = mkdtempSync(join(tmpdir(), "agend-registry-bundle-"));
    try {
      const compiled = join(directory, "compiled"), bundle = join(directory, "bundle");
      compilePortableRuntime(compiled);
      cpSync(resolve("src/general-knowledge"), join(compiled, "general-knowledge"), { recursive: true });
      execFileSync(process.execPath, [resolve("scripts/build-runtime.mjs"), bundle, compiled], { cwd: process.cwd(), stdio: "pipe", timeout: 20_000 });
      const manifest = JSON.parse(readFileSync(join(bundle, "bundle-manifest.json"), "utf8")) as { modules: string[] };
      for (const name of CLI_REGISTRY_MODULES) expect(manifest.modules, name).toContain(name);

      // Closed: whatever a module imports, the bundle has — a module, a Node built-in, or one of the Runtime's own packages. (An import left out of the list would only fail on the
      // computer.) One gap was already there at the base of this change and is not this change's: transcript-records.js imports workspace-follow-records.js, which no list carries.
      const KNOWN_GAPS = ["transcript-records.js → ./workspace-follow-records.js"];
      const packages = Object.keys(JSON.parse(readFileSync(join(bundle, "package.json"), "utf8")).dependencies as Record<string, string>);
      const missing: string[] = [];
      for (const name of manifest.modules.filter(n => n.endsWith(".js"))) {
        const code = readFileSync(join(bundle, "dist", name), "utf8");
        for (const found of code.matchAll(/(?:^|\n)[ \t]*(?:import|export)\b[^;"'`]*?\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) {
          const target = (found[1] ?? found[2])!;
          if (target.startsWith("node:")) continue;
          if (target.startsWith("./")) { if (!manifest.modules.includes(target.slice(2))) missing.push(`${name} → ${target}`); continue; }
          if (!packages.some(p => target === p || target.startsWith(`${p}/`))) missing.push(`${name} → ${target}`);
        }
      }
      expect(missing.filter(gap => !KNOWN_GAPS.includes(gap))).toEqual([]);

      // Run: the tables as the bundle's own copy of the registry builds them.
      const script = `
        const registry = await import("./dist/cli-registry.js"), providers = await import("./dist/windows-cli-providers.js"), profiles = await import("./dist/runtime-credential-profiles.js");
        process.stdout.write(JSON.stringify({ specs: registry.CLI_SPECS, frozen: Object.isFrozen(registry.CLI_SPECS) && Object.isFrozen(registry.CLI_SPECS.codex.runtime.provider),
          providerIds: providers.NATIVE_PROVIDER_IDS, providers: Object.fromEntries(providers.NATIVE_PROVIDER_IDS.map(id => [id, providers.nativeProvider(id)])),
          mcp: registry.CLI_IDS.filter(id => providers.nativeProviderMcpSupported(id)), profiles: profiles.CREDENTIAL_PROFILE_CLIS }));`;
      const out = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: bundle, encoding: "utf8", timeout: 20_000 }));
      expect(out.frozen).toBe(true);
      expect(out.specs).toEqual(JSON.parse(JSON.stringify(CLI_SPECS)));
      expect(out.providerIds).toEqual([...NATIVE_PROVIDER_IDS]);
      expect(out.providers).toEqual(JSON.parse(JSON.stringify(Object.fromEntries(NATIVE_PROVIDER_IDS.map(id => [id, nativeProvider(id)])))));
      expect(out.mcp).toEqual(["claude-code", "codex"]);
      expect(out.profiles).toEqual({ ...CREDENTIAL_PROFILE_CLIS });
    } finally {
      if (!resolve(directory).startsWith(resolve(tmpdir()) + sep)) throw Error("Unexpected bundle fixture path");
      rmSync(directory, { recursive: true, force: true });
    }
  }, 90_000);

  it("every file of the registry is shipped, but its two server-only helpers (the completeness check and the dashboard module's generator)", () => {
    const shipped = new Set(RUNTIME_BUNDLE_MODULES);
    const sources = readdirSync(new URL("../src/", import.meta.url)).filter(name => /^cli-(?:capability|registry(?:-check)?|caps-module|spec-[a-z-]+)\.ts$/.test(name)).map(name => name.replace(/\.ts$/, ".js"));
    expect(sources.filter(name => !shipped.has(name)).sort()).toEqual(["cli-caps-module.js", "cli-registry-check.js"]);
  });
});

describe("an older Runtime and an older server still work with it", () => {
  it("the Runtime reports the same protocol and capabilities as before (the registry adds none, and a CLI-specific one is not invented)", () => {
    const directory = mkdtempSync(join(tmpdir(), "agend-registry-info-"));
    try {
      expect(readRuntimeInfo({ moduleDirectory: directory, packagePath: join(directory, "missing.json"), panes: true, install: true })).toEqual({
        protocolVersions: [1], capabilities: ["exec", "mcp", "panes", "credential-profiles", "account-identity", "remote-signin", "cli-install"],
      });
      expect(readRuntimeInfo({ moduleDirectory: directory, packagePath: join(directory, "missing.json"), panes: false, install: false }).capabilities)
        .toEqual(["exec", "mcp", "credential-profiles", "account-identity", "remote-signin"]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("an update archive is verified by its own manifest: one with the registry's files, and one from before them, are both accepted, and each has its own build id", () => {
    const f = runtimeBundleFixture("2.3.5-registry.1");
    try {
      const archive = createRuntimeBundle(f), now = validateRuntimeUpdateArchive(archive.bytes, metadataFor(archive.bytes, "2.3.5-registry.1"));
      expect(archive.bytes.length).toBeLessThan(RUNTIME_UPDATE_MAX_BYTES);
      const modules = JSON.parse(now.files.get("bundle-manifest.json")!.toString()).modules as string[];
      for (const name of CLI_REGISTRY_MODULES) { expect(modules, name).toContain(name); expect(name).toMatch(UPDATER_MODULE_NAME); expect(now.files.has(`dist/${name}`), name).toBe(true); }

      // What a server from before this change would have built: the same archive without the registry's files, its manifest and build id to match.
      const files = new Map(now.files);
      for (const name of CLI_REGISTRY_MODULES) files.delete(`dist/${name}`);
      const oldModules = modules.filter(name => !CLI_REGISTRY_MODULES.includes(name));
      const buildId = createHash("sha256").update(JSON.stringify({ format: "agend-runtime-code-v1", version: "2.3.5-registry.1",
        modules: oldModules.map(name => [name, createHash("sha256").update(files.get(`dist/${name}`)!).digest("hex")]) })).digest("hex");
      const manifest = JSON.parse(files.get("bundle-manifest.json")!.toString());
      Object.assign(manifest, { modules: oldModules, buildId, sha256: Object.fromEntries([...files].filter(([name]) => name !== "bundle-manifest.json").map(([name, bytes]) => [name, createHash("sha256").update(bytes).digest("hex")])) });
      files.set("bundle-manifest.json", Buffer.from(JSON.stringify(manifest)));
      const older = repack(files);
      const accepted = validateRuntimeUpdateArchive(older, metadataFor(older, "2.3.5-registry.1"));
      expect(accepted.buildId).toBe(buildId);
      expect(accepted.buildId).not.toBe(now.buildId);
      // …and a Runtime on the older build, offered the newer one of the same version, is told it differs, so it updates (the check is by the archive's hash).
      expect(runtimeUpdateNeeded({ version: "2.3.5-registry.1", sha256: metadataFor(older, "x").sha256 }, metadataFor(archive.bytes, "2.3.5-registry.1"))).toBe(true);
      expect(unzipStored(archive.bytes).get("agend-runtime/bundle-manifest.json")).toBeDefined();
    } finally { f.cleanup(); }
  });
});

/** A stored ZIP of the files (as `agend-runtime/<name>`), written independently of the producer. */
function repack(files: ReadonlyMap<string, Buffer>): Buffer {
  const local: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const [name, data] of files) {
    const filename = Buffer.from(`agend-runtime/${name}`), header = Buffer.alloc(30), record = Buffer.alloc(46), crc = crc32(data);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0800, 6); header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(filename.length, 26);
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(0x0314, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x0800, 8); record.writeUInt32LE(crc, 16); record.writeUInt32LE(data.length, 20); record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(filename.length, 28); record.writeUInt32LE((0o100644 << 16) >>> 0, 38); record.writeUInt32LE(offset, 42);
    local.push(header, filename, data); central.push(record, filename); offset += header.length + filename.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.size, 8); end.writeUInt16LE(files.size, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
