import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

describe("standalone Windows runtime bundle", () => {
  it("loads outside the AgEnD dependency tree with only the pure-JavaScript ws dependency", () => {
    const directory = mkdtempSync(join(tmpdir(), "agend-runtime-bundle-"));
    try {
      const compiled = join(directory, "compiled"), bundle = join(directory, "bundle");
      execFileSync(process.execPath, [resolve("node_modules/@typescript/native/bin/tsc"), "--ignoreConfig", "--target", "ES2022", "--module", "Node16",
        "--moduleResolution", "Node16", "--strict", "--esModuleInterop", "--skipLibCheck", "--outDir", compiled,
        "src/runtime-cli.ts", "src/windows-native-mcp.ts"], { cwd: process.cwd(), stdio: "pipe", timeout: 30_000 });
      execFileSync(process.execPath, [resolve("scripts/build-runtime.mjs"), bundle, compiled], { cwd: process.cwd(), stdio: "pipe", timeout: 10_000 });
      const help = execFileSync(process.execPath, [join(bundle, "dist/runtime-cli.js"), "--help"], { cwd: directory, encoding: "utf8", timeout: 10_000 });
      expect(help).toContain("agend-runtime connect --server"); expect(help).toContain("foreground");
      expect(readdirSync(join(bundle, "node_modules"))).toEqual(["ws"]);
      expect(readFileSync(join(bundle,"LICENSE"),"utf8")).toContain("MIT License");
      const pkg = JSON.parse(readFileSync(join(bundle, "package.json"), "utf8")); expect(pkg.dependencies).toEqual({ ws: "8.22.0" });
      const manifest = JSON.parse(readFileSync(join(bundle, "bundle-manifest.json"), "utf8")); expect(manifest.nativeDependencies).toEqual([]);
      expect(manifest.modules).toContain("model-catalog-defaults.js");
      expect(readFileSync(join(bundle, "agend-runtime.cmd"), "utf8")).toContain('node.exe "%~dp0dist\\runtime-cli.js" %*');
    } finally {
      if (!resolve(directory).startsWith(resolve(tmpdir()) + sep)) throw Error("Unexpected runtime bundle fixture path");
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
