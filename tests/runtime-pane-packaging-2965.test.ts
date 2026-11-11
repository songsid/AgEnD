import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PANE_NATIVE_SHA256, RUNTIME_PANE_ASSETS } from "../src/runtime-pane-assets.js";
it("contributor installs use a script-free local Windows-only node-pty package", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  expect(pkg.devDependencies["node-pty"]).toBe("file:vendor/node-pty");
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
  expect(lock.packages["node_modules/node-pty"].hasInstallScript).not.toBe(true);
});
it("the local package retains both pinned architectures, original manifest, types and licenses", () => {
  const root = "vendor/node-pty"; expect(existsSync(root)).toBe(true);
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  expect(pkg).toMatchObject({ name: "node-pty", version: "1.1.0", main: "./lib/index.js", types: "./typings/node-pty.d.ts" });
  expect(pkg.scripts).toBeUndefined(); expect(pkg.dependencies).toBeUndefined();
  const original = JSON.parse(readFileSync(join(root, "upstream-package.json"), "utf8"));
  expect(original).toMatchObject({ name: "node-pty", version: "1.1.0" });
  expect(original.scripts.install).toBeTruthy();
  let checked = 0;
  for (const [file, sha] of Object.entries(PANE_NATIVE_SHA256)) { expect(createHash("sha256").update(readFileSync(join(root, file))).digest("hex"), file).toBe(sha); checked++; }
  expect(checked).toBe(8);
  expect(readFileSync(join(root, "LICENSE"), "utf8")).toContain("MIT");
  expect(readFileSync(join(root, "CONPTY-LICENSE"), "utf8")).toContain("MIT");
  expect(readFileSync(join(root, "CONPTY-NOTICE.md"), "utf8")).toContain("NOTICES AND INFORMATION");
  const pane = RUNTIME_PANE_ASSETS.find(p => p.name === "node-pty")!;
  for (const file of pane.files) expect(existsSync(join(root, file === "package.json" ? "upstream-package.json" : file)), file).toBe(true);
  expect(existsSync(join(root, "binding.gyp"))).toBe(false); expect(existsSync(join(root, "prebuilds/linux-x64"))).toBe(false);
});
it("the asset builder ships the original upstream manifest and every pinned Runtime file byte", async () => {
  const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import("node:fs"), { tmpdir } = await import("node:os"), { execFileSync } = await import("node:child_process");
  const home = mkdtempSync(join(tmpdir(), "agend-packaging-2965-"));
  try {
    const compiled = join(home, "compiled"), output = join(home, "output"), pane = RUNTIME_PANE_ASSETS.find(p => p.name === "node-pty")!;
    mkdirSync(compiled); writeFileSync(join(compiled, "package.json"), '{"type":"module"}');
    writeFileSync(join(compiled, "runtime-pane-assets.js"), `export const RUNTIME_PANE_ASSETS=${JSON.stringify([pane])}, RUNTIME_PANE_MODULES=[], PANE_NATIVE_SHA256=${JSON.stringify(PANE_NATIVE_SHA256)};`);
    execFileSync(process.execPath, ["scripts/build-runtime-assets.mjs", output, compiled], { timeout: 10000 });
    const hashes = JSON.parse(readFileSync("vendor/node-pty/upstream-files.sha256.json", "utf8")); let checked = 0;
    for (const file of pane.files) { expect(createHash("sha256").update(readFileSync(join(output, "node-pty", file))).digest("hex"), file).toBe(hashes[file === "package.json" ? "upstream-package.json" : file]); checked++; }
    expect(checked).toBeGreaterThan(20);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
