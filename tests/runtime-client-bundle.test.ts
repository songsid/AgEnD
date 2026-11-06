import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { compilePortableRuntime } from "./support/runtime-portable-compile.js";

describe("standalone Windows runtime bundle", () => {
  it("loads outside the AgEnD dependency tree without loading Windows native bindings for help/status", () => {
    const directory = mkdtempSync(join(tmpdir(), "agend-runtime-bundle-"));
    try {
      const compiled = join(directory, "compiled"), bundle = join(directory, "bundle");
      compilePortableRuntime(compiled);
      // Match postbuild: the portable builder consumes the built program assets too.
      cpSync(resolve("src/general-knowledge"), join(compiled, "general-knowledge"), { recursive: true });
      execFileSync(process.execPath, [resolve("scripts/build-runtime.mjs"), bundle, compiled, "https://fleet.example.test:10443"], { cwd: process.cwd(), stdio: "pipe", timeout: 10_000 });
      const help = execFileSync(process.execPath, [join(bundle, "dist/runtime-cli.js"), "--help"], { cwd: directory, encoding: "utf8", timeout: 10_000 });
      expect(help).toContain("agend-runtime connect --server"); expect(help).toContain("foreground");
      // The updater's verification library also loads using only this portable program tree, without profiles or CLIs.
      const artifact = execFileSync(process.execPath, ["--input-type=module", "-e", "import('./dist/runtime-update-artifact.js').then(m=>console.log(m.compareRuntimeVersions('2.0.0','1.0.0')))"], { cwd: bundle, encoding: "utf8", timeout: 10_000 });
      expect(artifact.trim()).toBe("1");
      expect(readdirSync(join(bundle, "node_modules"))).toEqual(["@xterm", "node-pty", "ws"]);
      expect(readFileSync(join(bundle,"LICENSE"),"utf8")).toContain("MIT License");
      const pkg = JSON.parse(readFileSync(join(bundle, "package.json"), "utf8")); expect(pkg.dependencies).toEqual({ ws: "8.22.0", "node-pty": "1.1.0", "@xterm/headless": "6.0.0", "@xterm/addon-serialize": "0.14.0" });
      const manifest = JSON.parse(readFileSync(join(bundle, "bundle-manifest.json"), "utf8")); expect(manifest.nativeDependencies).toEqual([{ name: "node-pty", version: "1.1.0", platforms: ["win32-x64", "win32-arm64"], backend: "ConPTY" }]);
      const runtimeHome=join(directory,"unused-profile");
      const info=JSON.parse(execFileSync(process.execPath,[join(bundle,"dist/runtime-cli.js"),"--version"],{cwd:directory,encoding:"utf8",timeout:10_000,env:{...process.env,AGEND_RUNTIME_HOME:runtimeHome}}));
      expect(info).toMatchObject({version:pkg.version,buildId:manifest.buildId,protocolVersions:[1]});expect(info.buildId).toMatch(/^[a-f0-9]{64}$/);expect(existsSync(runtimeHome)).toBe(false);
      expect(() => execFileSync(process.execPath, [join(bundle, "dist/runtime-cli.js"), "--internal-update"],
        { cwd: directory, stdio: "pipe", timeout: 10_000, env: { ...process.env, AGEND_RUNTIME_HOME: runtimeHome } })).toThrow(/Inherited native Runtime update channel required/);
      expect(existsSync(runtimeHome)).toBe(false);
      const source=join(bundle,"dist/runtime-cli.js");writeFileSync(source,readFileSync(source,"utf8")+"\n// changed runtime code\n");
      const changed=JSON.parse(execFileSync(process.execPath,[source,"--version"],{cwd:directory,encoding:"utf8",timeout:10_000}));
      expect(changed.version).toBe(info.version);expect(changed.buildId).not.toBe(info.buildId);
      expect(JSON.parse(readFileSync(join(bundle,"agend-server.json"),"utf8"))).toEqual({server:"https://fleet.example.test:10443"});
      expect(readFileSync(join(bundle,"connect-agend.bat"),"utf8")).toContain('node.exe "%~dp0dist\\runtime-cli.js" connect');
      execFileSync(process.execPath,[resolve("scripts/build-runtime.mjs"),bundle,compiled],{cwd:process.cwd(),stdio:"pipe",timeout:10_000});
      expect(existsSync(join(bundle,"agend-server.json"))).toBe(false);
      expect(manifest.modules).toContain("model-catalog-defaults.js");
      for (const arch of ["x64","arm64"]) {
        const path = `node_modules/node-pty/prebuilds/win32-${arch}/conpty.node`, bytes = readFileSync(join(bundle,path));
        expect(bytes.readUInt32LE(bytes.readUInt32LE(0x3c))).toBe(0x4550);
        expect(bytes.readUInt16LE(bytes.readUInt32LE(0x3c)+4)).toBe(arch === "x64" ? 0x8664 : 0xaa64);
        expect(bytes.includes(Buffer.from("napi_register_module_v1"))).toBe(true);
        expect(manifest.sha256[path]).toMatch(/^[a-f0-9]{64}$/);
      }
      expect(readFileSync(join(bundle,"node_modules/node-pty/CONPTY-LICENSE"),"utf8")).toContain("Microsoft Corporation");
      expect(readFileSync(join(bundle, "agend-runtime.cmd"), "utf8")).toContain('node.exe "%~dp0dist\\runtime-cli.js" %*');
    } finally {
      if (!resolve(directory).startsWith(resolve(tmpdir()) + sep)) throw Error("Unexpected runtime bundle fixture path");
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
