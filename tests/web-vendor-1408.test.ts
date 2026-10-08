/**
 * #1408 §0: Preact + htm, vendored with no build step. Every vendored byte is pinned by vendor/vendor.json:
 * - a changed byte in any file fails here;
 * - the one rewrite (the hooks file's bare `from"preact"` import) is the only difference from upstream — reversing
 *   it gives the upstream file's hash back;
 * - each package's licence ships beside it, and the files are served same-origin by exact name, on the public link too.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isServedAsset } from "../src/auth-api.js";
import { isPublicWebRoute } from "../src/public-web-gateway.js";

const SHARED = join(process.cwd(), "src", "ui", "shared");
const MANIFEST = JSON.parse(readFileSync(join(SHARED, "vendor", "vendor.json"), "utf8")) as {
  packages: Record<string, { version: string; integrity: string; license: string; licenseFile: string;
    files: Record<string, { upstream: string; sha256: string; upstreamSha256: string; rewrite?: { from: string; to: string } }> }>;
};
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const FILES = Object.entries(MANIFEST.packages).flatMap(([pkg, p]) => Object.entries(p.files).map(([name, f]) => ({ pkg, name, ...f })));

describe("the vendored files are exactly what the manifest pins", () => {
  it("pins Preact 10.29.8 and htm 3.1.1 from the npm registry, with integrity", () => {
    expect(MANIFEST.packages.preact!.version).toBe("10.29.8");
    expect(MANIFEST.packages.htm!.version).toBe("3.1.1");
    for (const p of Object.values(MANIFEST.packages)) expect(p.integrity).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
    expect(FILES.map(f => f.name).sort()).toEqual(["htm.module.js", "preact-hooks.module.js", "preact.module.js"]);
  });

  for (const f of FILES) {
    it(`${f.name}: byte-identical to the manifest`, () => {
      expect(sha256(readFileSync(join(SHARED, f.name)))).toBe(f.sha256);
    });
    it(`${f.name}: ${f.rewrite ? "upstream once its one rewrite is reversed" : "byte-identical to upstream"}`, () => {
      let text = readFileSync(join(SHARED, f.name), "utf8");
      if (f.rewrite) {
        expect(text.split(f.rewrite.to).length - 1, "the rewrite appears exactly once").toBe(1);
        text = text.replace(f.rewrite.to, f.rewrite.from);
      } else expect(f.sha256).toBe(f.upstreamSha256);
      expect(sha256(text)).toBe(f.upstreamSha256);
    });
  }

  it("the hooks file imports Preact by a relative path (no import map, no bare specifier left)", () => {
    const hooks = readFileSync(join(SHARED, "preact-hooks.module.js"), "utf8");
    expect(hooks).toContain('from"./preact.module.js"');
    for (const name of ["preact.module.js", "preact-hooks.module.js", "htm.module.js"]) {
      const src = readFileSync(join(SHARED, name), "utf8");
      const specifiers = [...src.matchAll(/from\s*"([^"]+)"/g)].map(m => m[1]);
      for (const s of specifiers) expect(s, `${name} imports ${s}`).toMatch(/^\.\//);
    }
  });

  it("no eval and no Function constructor in what the CSP must run without 'unsafe-eval'", () => {
    for (const f of FILES) {
      const src = readFileSync(join(SHARED, f.name), "utf8");
      expect(src, f.name).not.toMatch(/\beval\s*\(/);
      expect(src, f.name).not.toMatch(/new\s+Function\s*\(/);
    }
  });
});

describe("licences and serving", () => {
  it("each package's licence ships beside the files", () => {
    const preact = readFileSync(join(SHARED, MANIFEST.packages.preact!.licenseFile), "utf8");
    expect(MANIFEST.packages.preact!.license).toBe("MIT");
    expect(preact).toContain("The MIT License");
    expect(preact).toContain("Jason Miller");
    const htm = readFileSync(join(SHARED, MANIFEST.packages.htm!.licenseFile), "utf8");
    expect(MANIFEST.packages.htm!.license).toBe("Apache-2.0");
    expect(htm).toContain("Apache License");
    expect(htm).toContain("Version 2.0");
  });

  it("served from /assets by exact name, and listed on the public link — the licences and manifest are not", () => {
    for (const f of FILES) {
      expect(isServedAsset(f.name), f.name).toBe(true);
      expect(isPublicWebRoute("GET", `/assets/${f.name}`), f.name).toBe(true);
    }
    for (const name of ["vendor/vendor.json", "vendor.json", "preact.LICENSE", "vendor/preact.LICENSE", "preact.module.js.map", "hooks.module.js"]) {
      expect(isServedAsset(name), name).toBe(false);
    }
  });
});
