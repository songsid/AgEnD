import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// The attempt has to be on the device before the process is replaced. Nothing
// observable from outside proves that, so the call itself is what we pin.
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, fsyncSync: vi.fn(actual.fsyncSync) };
});

const { fsyncSync } = await import("node:fs");
const { recordSelfRestartAttempt } = await import("../src/self-restart-limit.js");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.mocked(fsyncSync).mockClear();
});

describe("recording a self-restart attempt", () => {
  it("fsyncs before reporting success", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-fsync-"));
    dirs.push(dir);

    expect(recordSelfRestartAttempt(dir)).toBe(true);

    // Without this the attempt can sit in the page cache and die with the
    // process — a rate limit whose counter resets on every restart.
    expect(fsyncSync).toHaveBeenCalledTimes(1);
  });
});
