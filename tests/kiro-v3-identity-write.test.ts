/**
 * #1171 review round 2: a claim's owner line may land short. It is claimed
 * only once the whole line is on disk; one that cannot be finished is
 * removed, and nothing is taken up.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const writer = vi.hoisted(() => ({ mode: "real" as "real" | "one-byte" | "stuck" | "one-then-stuck", calls: 0 }));
vi.mock("node:fs", async importOriginal => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    writeSync: ((fd: number, buffer: Buffer, offsetArg?: number | null, length?: number | null) => {
      const offset = offsetArg ?? 0;
      const len = length ?? buffer.length - offset;
      if (writer.mode === "stuck") return 0;
      if (writer.mode === "one-then-stuck" && writer.calls++ > 0) return 0;
      if (writer.mode === "one-then-stuck") return real.writeSync(fd, buffer, offset, Math.min(1, len));
      if (writer.mode === "one-byte") return real.writeSync(fd, buffer, offset, Math.min(1, len));
      return real.writeSync(fd, buffer, offset, len);
    }) as typeof real.writeSync,
  };
});

import { kasBucket } from "../src/backend/kiro-kas-store.js";
import { resolveKiroV3Resume } from "../src/backend/kiro-v3-identity.js";

const dirs: string[] = [];
afterEach(() => { writer.mode = "real"; writer.calls = 0; for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function setup() {
  const mk = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
  const agendHome = mk("agend-v3w-home-"), kiroHome = mk("agend-v3w-kiro-"), work = mk("agend-v3w-work-");
  const resolve = (now?: Date) => resolveKiroV3Resume("alphabet", work, null, { agendHome, env: { KIRO_HOME: kiroHome }, now });
  expect(resolve(new Date("2026-10-03T02:00:00.000Z"))).toBeNull();
  const dir = join(kiroHome, "sessions", kasBucket(work), "sess_mine");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "session.json"), JSON.stringify({ createdAt: "2026-10-03T02:00:05.000Z", lastModifiedAt: "2026-10-03T02:00:05.000Z" }));
  return { resolve, claim: join(agendHome, "kiro-v3", "claims", "sess_mine") };
}

describe("the owner line of a claim", () => {
  it("written a byte at a time is finished, and then the session is taken up", () => {
    const { resolve, claim } = setup();
    writer.mode = "one-byte";
    expect(resolve()).toBe("sess_mine");
    expect(readFileSync(claim, "utf8")).toBe("alphabet\n");
  });

  it("that makes no progress is not a claim: removed, and nothing taken up", () => {
    const { resolve, claim } = setup();
    writer.mode = "stuck";
    expect(resolve()).toBeNull();
    expect(existsSync(claim)).toBe(false);
  });

  it("cut short after part of the name is not a claim — a prefix of it could be another instance's whole name", () => {
    const { resolve, claim } = setup();
    writer.mode = "one-then-stuck";
    expect(resolve()).toBeNull();
    expect(existsSync(claim)).toBe(false);
  });
});
