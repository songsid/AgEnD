/**
 * AGEND-115: the registry's data files are read by the server AND by a Windows Runtime out of its own bundle, which has no AgEnD server code and no Linux-only
 * packages. So they may import only Node built-ins and each other, and hold no code that does anything but describe.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CLI_IDS } from "../src/cli-capability.js";

/** The files the Runtime bundle carries (RUNTIME_BUNDLE_MODULES lists them as .js). */
export const REGISTRY_DATA_MODULES = ["cli-capability", "cli-registry", ...CLI_IDS.map(id => `cli-spec-${id}`)] as const;

describe("the registry's data files can ride in the Runtime bundle", () => {
  const read = (name: string) => readFileSync(new URL(`../src/${name}.ts`, import.meta.url), "utf8");

  it("import only built-ins and each other", () => {
    for (const name of REGISTRY_DATA_MODULES) {
      const imports = [...read(name).matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s+"([^"]+)"/g)].map(m => m[1]!);
      if (name === "cli-registry") expect(imports).toHaveLength(1 + CLI_IDS.length + 2);   // cli-capability (imported, and its values and types re-exported), the seven specs, and nothing else
      if (name.startsWith("cli-spec-")) expect(imports).toEqual(["./cli-capability.js"]);
      for (const from of imports) {
        const allowed = from.startsWith("node:") || (from.startsWith("./") && REGISTRY_DATA_MODULES.includes(from.slice(2).replace(/\.js$/, "") as never));
        expect(allowed, `${name} imports ${from}`).toBe(true);
      }
      expect(read(name), `${name} must not load anything at run time`).not.toMatch(/\b(?:require|import)\s*\(/);
    }
  });

  it("start nothing, read nothing and touch no network, disk or environment", () => {
    for (const name of REGISTRY_DATA_MODULES) {
      expect(read(name), name).not.toMatch(/\b(?:process\.|child_process|fetch\(|readFileSync|writeFileSync|spawn\(|exec\(|execFile\(|globalThis|eval\()/);
    }
  });

  it("has one spec file per CLI, and every CLI in CLI_IDS is in the registry's table", () => {
    const registry = read("cli-registry");
    for (const id of CLI_IDS) expect(registry, id).toContain(`from "./cli-spec-${id}.js"`);
  });
});
