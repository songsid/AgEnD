/**
 * The Windows Runtime bundle is closed: every file one of its modules imports (statically, with `import()`, or by spawning `new URL("./file", import.meta.url)`) is a file the
 * bundle carries, a Node built-in, or one of the Runtime's own packages. A module that imports a file the bundle left out loads fine on the server, where `dist/` has every
 * file, and fails with ERR_MODULE_NOT_FOUND only on the computer — so this builds the bundle from the same sources `agend` ships and reads it back.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { RUNTIME_BUNDLE_MODULES } from "../src/runtime-build-info.js";
import { bundleGaps } from "./support/runtime-bundle-gaps.js";
import { compilePortableRuntime } from "./support/runtime-portable-compile.js";

describe("the closure check itself", () => {
  const listed = ["a.js", "b.js"];
  const check = (code: string) => bundleGaps(new Map([["a.js", code]]), listed, ["ws"]);

  it("passes what the bundle carries: a module, a built-in, a package, a spawned file", () => {
    expect(check([`import { x } from "./b.js";`, `import { y } from "node:fs";`, `import WebSocket from "ws";`, `export { z } from "ws/lib/x.js";`,
      `const c = await import("./b.js");`, `spawn(process.execPath, [fileURLToPath(new URL("./b.js", import.meta.url))]);`].join("\n"))).toEqual([]);
  });

  it("reports each kind of reference to a file the bundle does not carry", () => {
    expect(check([`import { x } from "./missing-static.js";`, `export * from "./missing-reexport.js";`, `await import("./missing-dynamic.js");`,
      `new URL("./missing-child.js", import.meta.url);`, `import "left-pad";`].join("\n")))
      .toEqual(["a.js → ./missing-static.js", "a.js → ./missing-reexport.js", "a.js → ./missing-dynamic.js", "a.js → ./missing-child.js", "a.js → left-pad"]);
  });

  it("does not take a mention in a comment or a string for a reference", () => {
    expect(check(["// import { x } from './nowhere.js'", `const note = "see ./nowhere.js";`].join("\n"))).toEqual([]);
  });
});

describe("the built bundle", () => {
  it("carries every file its modules import or start (a missing one fails only on the computer)", () => {
    const directory = mkdtempSync(join(tmpdir(), "agend-bundle-closed-"));
    try {
      const compiled = join(directory, "compiled"), bundle = join(directory, "bundle");
      compilePortableRuntime(compiled);
      cpSync(resolve("src/general-knowledge"), join(compiled, "general-knowledge"), { recursive: true });
      execFileSync(process.execPath, [resolve("scripts/build-runtime.mjs"), bundle, compiled], { cwd: process.cwd(), stdio: "pipe", timeout: 20_000 });
      const manifest = JSON.parse(readFileSync(join(bundle, "bundle-manifest.json"), "utf8")) as { modules: string[] };
      expect(manifest.modules).toEqual([...RUNTIME_BUNDLE_MODULES]);
      const packages = Object.keys(JSON.parse(readFileSync(join(bundle, "package.json"), "utf8")).dependencies as Record<string, string>);
      const modules = new Map(manifest.modules.filter(name => name.endsWith(".js")).map(name => [name, readFileSync(join(bundle, "dist", name), "utf8")] as const));
      expect(modules.size).toBeGreaterThan(50);                       // the scan read the bundle, not an empty directory
      expect(bundleGaps(modules, manifest.modules, packages)).toEqual([]);
    } finally {
      if (!resolve(directory).startsWith(resolve(tmpdir()) + sep)) throw Error("Unexpected bundle fixture path");
      rmSync(directory, { recursive: true, force: true });
    }
  }, 90_000);
});
