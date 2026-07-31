import { describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSecretFile } from "../src/secret-file.js";

/**
 * Every secret-writing site already did the right two things:
 *
 *   writeFileSync(path, content, { mode: 0o600 });
 *   try { chmodSync(path, 0o600); } catch {}
 *
 * The chmod is needed because writeFileSync's mode only applies on *create*, so
 * an overwritten file keeps whatever permissions it already had. Which means the
 * only situation where the chmod does anything is the situation where the file is
 * already too permissive — and that is precisely the situation the bare `catch {}`
 * hid. The secret stayed readable and nothing said so.
 */

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "agend-secret-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const isWindows = process.platform === "win32";

describe("writeSecretFile", () => {
  it("creates an owner-only file", () => {
    withTempDir(dir => {
      const path = join(dir, "agent.token");
      const result = writeSecretFile(path, "deadbeef");

      expect(readFileSync(path, "utf-8")).toBe("deadbeef");
      expect(result.ok).toBe(true);
      if (!isWindows) expect(statSync(path).mode & 0o777).toBe(0o600);
    });
  });

  it("tightens a file that already exists with loose permissions", () => {
    if (isWindows) return;
    withTempDir(dir => {
      const path = join(dir, "env");
      writeFileSync(path, "OLD=1");
      chmodSync(path, 0o644); // world-readable, e.g. restored from a backup

      const result = writeSecretFile(path, "TELEGRAM_BOT_TOKEN=secret");

      // writeFileSync alone would have left this at 0644 with the token in it.
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(result.ok).toBe(true);
    });
  });

  it("reports a chmod that failed, instead of swallowing it", () => {
    // The bare `catch {}` this replaces made exactly this case invisible.
    const result = writeSecretFile("/x/env", "TOKEN=secret", {
      write: () => {},
      chmod: () => { throw new Error("EPERM: operation not permitted"); },
      mode: () => 0o644,
    });

    expect(result.ok).toBe(false);
    expect(result.mode).toBe(0o644);
    expect(result.reason).toContain("EPERM");
  });

  it("reports a chmod that succeeded but left the file readable", () => {
    // chmod can return without error on filesystems that do not honour modes
    // (a mounted share, some container overlays). Trusting it is not enough.
    const result = writeSecretFile("/x/env", "TOKEN=secret", {
      write: () => {},
      chmod: () => {},
      mode: () => 0o644,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("644");
  });

  it("accepts a mode stricter than requested", () => {
    // The check is on the group/other bits, not equality with 0o600: 0o400 is
    // fine, and some filesystems will not reproduce an exact mode.
    const result = writeSecretFile("/x/env", "TOKEN=secret", {
      write: () => {}, chmod: () => {}, mode: () => 0o400,
    });

    expect(result.ok).toBe(true);
  });

  it("reports when the file cannot be stat'd after writing", () => {
    const result = writeSecretFile("/x/env", "TOKEN=secret", {
      write: () => {}, chmod: () => {}, mode: () => null,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("stat");
  });

  it("lets a genuine write failure surface to the caller", () => {
    // A token that cannot be tightened is still usable; a path that cannot be
    // written is a real error and must not be reported as a permissions nit.
    withTempDir(dir => {
      expect(() => writeSecretFile(join(dir, "nope", "env"), "x")).toThrow();
    });
  });
});
