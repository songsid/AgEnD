import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

describe("standalone Windows runtime bundle", () => {
  it("loads outside the AgEnD dependency tree without loading Windows native bindings for help/status", () => {
    const directory = mkdtempSync(join(tmpdir(), "agend-runtime-bundle-"));
    try {
      const compiled = join(directory, "compiled"), bundle = join(directory, "bundle");
      execFileSync(process.execPath, [resolve("node_modules/@typescript/native/bin/tsc"), "--ignoreConfig", "--target", "ES2022", "--module", "Node16",
        "--moduleResolution", "Node16", "--strict", "--esModuleInterop", "--skipLibCheck", "--outDir", compiled,
        "src/runtime-cli.ts", "src/windows-native-mcp.ts"], { cwd: process.cwd(), stdio: "pipe", timeout: 30_000 });
      // Match postbuild: the portable builder consumes the built program assets too.
      cpSync(resolve("src/general-knowledge"), join(compiled, "general-knowledge"), { recursive: true });
      execFileSync(process.execPath, [resolve("scripts/build-runtime.mjs"), bundle, compiled], { cwd: process.cwd(), stdio: "pipe", timeout: 10_000 });
      const help = execFileSync(process.execPath, [join(bundle, "dist/runtime-cli.js"), "--help"], { cwd: directory, encoding: "utf8", timeout: 10_000 });
      expect(help).toContain("agend-runtime connect --server"); expect(help).toContain("foreground");
      expect(readdirSync(join(bundle, "node_modules"))).toEqual(["@xterm", "node-pty", "ws"]);
      expect(readFileSync(join(bundle,"LICENSE"),"utf8")).toContain("MIT License");
      const pkg = JSON.parse(readFileSync(join(bundle, "package.json"), "utf8")); expect(pkg.dependencies).toEqual({ ws: "8.22.0", "node-pty": "1.1.0", "@xterm/headless": "6.0.0", "@xterm/addon-serialize": "0.14.0" });
      const manifest = JSON.parse(readFileSync(join(bundle, "bundle-manifest.json"), "utf8")); expect(manifest.nativeDependencies).toEqual([{ name: "node-pty", version: "1.1.0", platforms: ["win32-x64", "win32-arm64"], backend: "ConPTY" }]);
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
