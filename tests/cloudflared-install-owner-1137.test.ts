/**
 * #1141 review: a bin owned by someone else is refused even when AgEnD's home
 * is ours. Files of another uid cannot be made without root, so lstat reports
 * the foreign owner for the bin directory only.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const foreignBin = vi.hoisted(() => ({ path: "" }));
vi.mock("node:fs/promises", async importOriginal => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    lstat: (async (p: string, ...rest: unknown[]) => {
      const st = await (real.lstat as (...a: unknown[]) => Promise<import("node:fs").Stats>)(p, ...rest);
      if (foreignBin.path && p === foreignBin.path) return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid: st.uid + 1 });
      return st;
    }) as typeof real.lstat,
  };
});

import { ensureCloudflared } from "../src/tunnel/cloudflared-install.js";

const dirs: string[] = [];
afterEach(() => { foreignBin.path = ""; for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("a bin that belongs to another user", () => {
  it("is refused, and nothing is fetched", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "agend-cf-owner-"));
    dirs.push(dataDir);
    foreignBin.path = join(dataDir, "bin");
    const fetchImpl = vi.fn();
    const err = await ensureCloudflared({ dataDir, env: { PATH: "/nonexistent" }, platform: "linux", arch: "x64", fetchImpl }).catch(e => e);
    expect(err.kind).toBe("install-failed");
    expect(err.message).toContain("belongs to another user");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
