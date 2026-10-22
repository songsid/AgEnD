/**
 * #2445: tsc is TypeScript 7.0.2; import "typescript" is the 6.x compiler API.
 * Official side-by-side aliases: @typescript/native → typescript@7.0.2,
 * typescript → @typescript/typescript6@6.0.2.
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";

const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
  files: string[];
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

describe("TypeScript 7 dual-package (#2445)", () => {
  it("pins the official aliases at exact versions", () => {
    expect(pkg.devDependencies["@typescript/native"]).toBe("npm:typescript@7.0.2");
    expect(pkg.devDependencies.typescript).toBe("npm:@typescript/typescript6@6.0.2");
    expect(pkg.dependencies?.typescript).toBeUndefined();
    expect(pkg.dependencies?.["@typescript/native"]).toBeUndefined();
  });

  it("npx tsc is 7.0.2 and import typescript is the 6 API", () => {
    const tsc = spawnSync("npx", ["tsc", "--version"], { encoding: "utf8", cwd: process.cwd() });
    expect(tsc.status, tsc.stderr).toBe(0);
    expect(tsc.stdout).toMatch(/Version 7\.0\.2/);
    expect(ts.version).toMatch(/^6\./);
    expect(typeof ts.createSourceFile).toBe("function");
    expect(typeof ts.transpileModule).toBe("function");
  });

  it("the published files list does not include tsc or the compiler packages", () => {
    const packed = pkg.files.join("\n");
    expect(packed).not.toMatch(/typescript|node_modules|\btsc\b/);
  });
});
