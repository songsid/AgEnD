/**
 * `agend export` writes an archive that holds the fleet's secrets (.env): it is private from its first byte — created
 * exclusively, 0600, never through a link — for both export kinds, whatever the umask. An existing destination (a file,
 * a symlink, a directory) is refused and left as it was; a failed tar leaves no partial archive behind.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportConfig, openPrivateArchive } from "../src/export-import.js";

let root: string, dataDir: string, mask: number;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agend-export-perms-"));
  dataDir = join(root, "home", ".agend");
  mkdirSync(join(dataDir, "instances", "a"), { recursive: true });
  writeFileSync(join(dataDir, "fleet.yaml"), "instances: {}\n");
  writeFileSync(join(dataDir, ".env"), "AGEND_BOT_TOKEN=x\n", { mode: 0o600 });
  writeFileSync(join(dataDir, "instances", "a", "session-id"), "s\n");
  mask = process.umask(0o022);
});
afterEach(() => {
  process.umask(mask);
  vi.restoreAllMocks();
  for (const d of [join(dataDir, "instances", "a")]) try { chmodSync(d, 0o700); } catch { /* gone */ }
  rmSync(root, { recursive: true, force: true });
});
const mode = (p: string) => statSync(p).mode & 0o777;
/** process.exit as a throw, so a refusal can be asserted (and nothing after it runs). */
const exits = () => vi.spyOn(process, "exit").mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never);

describe("the archive is private (umask 022)", () => {
  for (const full of [false, true]) {
    it(`${full ? "full" : "minimal"} export: 0600, and a whole archive`, async () => {
      vi.spyOn(console, "log").mockImplementation(() => {}); vi.spyOn(console, "warn").mockImplementation(() => {});
      const out = join(root, `out-${full}.tar.gz`);
      await exportConfig(dataDir, out, full);
      expect(mode(out)).toBe(0o600);
      const listing = execFileSync("tar", ["tzf", out]).toString();
      expect(listing).toContain(".agend/.env");
      expect(listing.includes("session-id")).toBe(full);
    });
  }
  it("private from its first byte: the file is 0600 when it is created, before anything is written — even under umask 0", () => {
    process.umask(0);
    const out = join(root, "fresh.tar.gz");
    const fd = openPrivateArchive(out);
    try { expect([fstatSync(fd).mode & 0o777, fstatSync(fd).size]).toEqual([0o600, 0]); } finally { closeSync(fd); }
  });
});

describe("an existing destination is refused, never replaced or followed", () => {
  beforeEach(() => { vi.spyOn(console, "error").mockImplementation(() => {}); });
  it("a file: refused, its content and mode as they were", async () => {
    const out = join(root, "taken.tar.gz");
    writeFileSync(out, "keep me", { mode: 0o644 });
    exits();
    await expect(exportConfig(dataDir, out, false)).rejects.toThrow("exit 1");
    expect([readFileSync(out, "utf8"), mode(out)]).toEqual(["keep me", 0o644]);
  });
  it("a symlink to a file: refused, the link and its target untouched", async () => {
    const target = join(root, "victim.txt"), out = join(root, "link.tar.gz");
    writeFileSync(target, "victim", { mode: 0o644 });
    symlinkSync(target, out);
    exits();
    await expect(exportConfig(dataDir, out, true)).rejects.toThrow("exit 1");
    expect([readFileSync(target, "utf8"), mode(target), lstatSync(out).isSymbolicLink(), readlinkSync(out)]).toEqual(["victim", 0o644, true, target]);
  });
  it("a dangling symlink: refused, its target never created", async () => {
    const target = join(root, "nowhere.tar.gz"), out = join(root, "dangling.tar.gz");
    symlinkSync(target, out);
    exits();
    await expect(exportConfig(dataDir, out, false)).rejects.toThrow("exit 1");
    expect(existsSync(target)).toBe(false);
    expect(lstatSync(out).isSymbolicLink()).toBe(true);
  });
  it("a directory: refused", async () => {
    const out = join(root, "a-dir");
    mkdirSync(out);
    exits();
    await expect(exportConfig(dataDir, out, false)).rejects.toThrow("exit 1");
    expect(statSync(out).isDirectory()).toBe(true);
  });
});

describe("a failed export leaves nothing behind", () => {
  it.skipIf(process.getuid?.() === 0)("tar fails (an unreadable directory): no partial archive", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {}); vi.spyOn(console, "warn").mockImplementation(() => {});
    chmodSync(join(dataDir, "instances", "a"), 0o000);
    const out = join(root, "partial.tar.gz");
    await expect(exportConfig(dataDir, out, true)).rejects.toThrow();
    expect(existsSync(out)).toBe(false);
  });
});
