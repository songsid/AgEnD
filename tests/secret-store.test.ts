import { describe, expect, it } from "vitest";
import { lstatSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretStore } from "../src/secret-store.js";

function withTemp<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "agend-secret-store-"));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("SecretStore", () => {
  it("writes an allowlisted key atomically with owner-only permissions", () => withTemp(dir => {
    const path = join(dir, ".env");
    const store = new SecretStore(path, new Set(["DISCORD_BOT_TOKEN"]));
    const before = store.write("DISCORD_BOT_TOKEN", "token-value");
    expect(before.exists).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("DISCORD_BOT_TOKEN=token-value\n");
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(lstatSync(path).isSymbolicLink()).toBe(false);
  }));

  it("preserves unrelated env lines and restores a snapshot on rollback", () => withTemp(dir => {
    const path = join(dir, ".env");
    writeFileSync(path, "# keep\nOTHER=value\nDISCORD_BOT_TOKEN=old\n", { mode: 0o600 });
    const store = new SecretStore(path, new Set(["DISCORD_BOT_TOKEN"]));
    const before = store.write("DISCORD_BOT_TOKEN", "new");
    expect(readFileSync(path, "utf8")).toContain("OTHER=value");
    expect(readFileSync(path, "utf8")).toContain("DISCORD_BOT_TOKEN=new");
    store.restore(before);
    expect(readFileSync(path, "utf8")).toBe("# keep\nOTHER=value\nDISCORD_BOT_TOKEN=old\n");
  }));

  it("restores the old content when the post-rename directory sync fails", () => withTemp(dir => {
    const path = join(dir, ".env");
    writeFileSync(path, "DISCORD_BOT_TOKEN=old\n", { mode: 0o600 });
    let syncs = 0;
    const store = new SecretStore(path, new Set(["DISCORD_BOT_TOKEN"]), {
      fsync: () => { if (++syncs === 2) throw new Error("directory fsync failed"); },
    });
    expect(() => store.write("DISCORD_BOT_TOKEN", "new")).toThrow(/atomically/);
    expect(readFileSync(path, "utf8")).toBe("DISCORD_BOT_TOKEN=old\n");
  }));

  it("rejects unconfigured and dangerous keys before writing", () => withTemp(dir => {
    const store = new SecretStore(join(dir, ".env"), new Set(["TELEGRAM_BOT_TOKEN"]));
    expect(() => store.write("OTHER_SECRET", "x")).toThrow(/not configured/);
    expect(() => store.write("NODE_OPTIONS", "--require evil")).toThrow(/not allowed/);
  }));

  it("fails closed for a symlink target", () => withTemp(dir => {
    const path = join(dir, ".env");
    const target = join(dir, "target");
    writeFileSync(target, "ORIGINAL\n", { mode: 0o600 });
    symlinkSync(target, path);
    expect(() => new SecretStore(path, new Set(["TOKEN"]))).toThrow(/symlink/);
    expect(readFileSync(target, "utf8")).toBe("ORIGINAL\n");
  }));
});
