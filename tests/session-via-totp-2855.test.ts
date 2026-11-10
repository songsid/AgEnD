/**
 * M-2855 (3): a session made by an authenticator sign-in carries `via: "totp"` (display only), and the store keeps it
 * across a restart. It is never set beside `host` or `remote`, nor on anything but an admin session.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSessionStore, sessionVia, tokenEpoch } from "../src/web-session.js";

const EPOCH = tokenEpoch("e".repeat(48)), OWNER = { adapterId: "a", userId: "100" }, EXPOSURE = "f".repeat(32);
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("M-2855: via totp", () => {
  it("survives a restart (the file is read back as the same row), on the local and the gateway surface", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-2855-")); dirs.push(dir);
    const a = new WebSessionStore({ dataDir: dir });
    a.create({ tier: "admin", surface: "local", label: "Safari on iPhone", tokenEpoch: EPOCH, owner: OWNER, via: "totp" });
    a.create({ tier: "admin", surface: "gateway", label: "Chrome on Android", tokenEpoch: EPOCH, exposureId: EXPOSURE, owner: OWNER, via: "totp" });
    a.create({ tier: "admin", surface: "local", label: "Firefox on Linux", tokenEpoch: EPOCH, via: "totp" });
    expect(JSON.parse(readFileSync(join(dir, "web-sessions.json"), "utf8")).sessions.filter((r: { via?: string }) => r.via === "totp")).toHaveLength(3);
    const b = new WebSessionStore({ dataDir: dir });
    expect(b.list().map(r => [r.label, r.via]).sort()).toEqual([["Chrome on Android", "totp"], ["Firefox on Linux", "totp"], ["Safari on iPhone", "totp"]]);
  });
  it("a stored row with the mark beside host or remote, or on a read session, is not read back (the file is checked as the store makes it)", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-2855-")); dirs.push(dir);
    const a = new WebSessionStore({ dataDir: dir });
    a.create({ tier: "admin", surface: "local", label: "kept", tokenEpoch: EPOCH, owner: OWNER, via: "totp" });
    const file = join(dir, "web-sessions.json"), body = JSON.parse(readFileSync(file, "utf8"));
    const [good] = body.sessions;
    const bad = (patch: Record<string, unknown>, handle: string) => ({ ...good, ...patch, handle, idHash: handle.repeat(4) });
    body.sessions.push(bad({ host: true, owner: undefined }, "1".repeat(16)), bad({ tier: "read" }, "2".repeat(16)));
    writeFileSync(file, JSON.stringify(body));
    expect(new WebSessionStore({ dataDir: dir }).list().map(r => r.label)).toEqual(["kept"]);
  });
  it("never beside host or remote, never on a read or guest session: the store drops the mark", () => {
    const s = new WebSessionStore();
    expect(s.create({ tier: "admin", surface: "local", label: "x", tokenEpoch: EPOCH, host: true, via: "totp" }).record.via).toBeUndefined();
    expect(s.create({ tier: "admin", surface: "gateway", label: "x", tokenEpoch: EPOCH, exposureId: EXPOSURE, remote: "totp", via: "totp" }).record.via).toBeUndefined();
    expect(s.create({ tier: "read", surface: "local", label: "x", tokenEpoch: EPOCH, via: "totp" }).record.via).toBeUndefined();
    expect(s.create({ tier: "guest", surface: "local", label: "x", tokenEpoch: EPOCH, owner: OWNER, via: "totp" }).record.via).toBeUndefined();
  });
  it("describes it as the authenticator app; `device` and `host` still win as before", () => {
    expect(sessionVia({ via: "totp" })).toBe("totp");
    expect(sessionVia({ remote: "totp" })).toBe("totp");
    expect(sessionVia({})).toBe("code");
  });
});
