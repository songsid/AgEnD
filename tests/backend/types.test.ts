import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveBinary } from "../../src/backend/types.js";

describe("resolveBinary", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("uses an executable absolute fallback when PATH lookup misses", () => {
    const dir = join(tmpdir(), `agend-binary-${process.pid}-${Date.now()}`);
    dirs.push(dir);
    mkdirSync(dir, { recursive: true });
    const binary = join(dir, "codex");
    writeFileSync(binary, "#!/bin/sh\nexit 0\n");
    chmodSync(binary, 0o755);

    const originalPath = process.env.PATH;
    process.env.PATH = "";
    try {
      expect(resolveBinary("codex", [dir])).toBe(binary);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("keeps the bare command fallback when no executable is found", () => {
    const dir = join(tmpdir(), `agend-binary-missing-${process.pid}-${Date.now()}`);
    dirs.push(dir);
    mkdirSync(dir, { recursive: true });

    expect(resolveBinary("not-a-real-agend-backend", [dir])).toBe("not-a-real-agend-backend");
  });
});
