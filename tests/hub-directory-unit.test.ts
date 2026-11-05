/**
 * S-43 Hub directory sign-in — checks that need no directory: configuration refusals (LDAPS only, no way to turn off
 * certificate checks), identity helpers, input refusals, plaintext and unreachable servers. The fake-directory cases
 * are in hub-directory-rig.test.ts.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHubDirectory, HubDirectoryConfigError, resolveDirectoryConfig } from "../src/hub/directory/index.js";
import { escapeFilterValue, guidBytesToString, guidStringToBytes, isDisabled, objectIdMatch, readObjectId } from "../src/hub/directory/profiles.js";

const base = { realm: "corp", url: "ldaps://directory.test:636", baseDn: "dc=example,dc=test", bindDn: "cn=reader,dc=example,dc=test", profile: "openldap" as const };
const secrets = { bindPassword: "s".repeat(24) };
const PASSWORD = "Pw-unit-" + "q".repeat(20);

interface Recorder { server: Server; port: number; connections: number; bytes: Buffer[] ; sockets: Socket[] }
const recorders: Recorder[] = [];
async function recorder(mode: "silent" | "close"): Promise<Recorder> {
  const r: Recorder = { server: createServer(), port: 0, connections: 0, bytes: [], sockets: [] };
  r.server.on("connection", (s) => {
    r.connections += 1;
    r.sockets.push(s);
    s.on("data", (d) => r.bytes.push(Buffer.from(d)));
    s.on("error", () => {});
    if (mode === "close") s.end();
  });
  await new Promise<void>((res) => r.server.listen(0, "127.0.0.1", res));
  r.port = (r.server.address() as { port: number }).port;
  recorders.push(r);
  return r;
}
afterEach(async () => {
  for (const r of recorders.splice(0)) {
    for (const s of r.sockets) s.destroy();
    await new Promise((res) => r.server.close(res));
  }
});

describe("hub directory configuration (S-43)", () => {
  it("accepts ldaps:// and fills profile defaults", () => {
    const cfg = resolveDirectoryConfig(base);
    expect(cfg).toMatchObject({ host: "directory.test", port: 636, url: "ldaps://directory.test:636", loginAttribute: "uid", userFilter: "(objectClass=person)" });
    expect(resolveDirectoryConfig({ ...base, url: "ldaps://directory.test", profile: "ad" })).toMatchObject({ port: 636, loginAttribute: "sAMAccountName" });
    expect(resolveDirectoryConfig({ ...base, bindPasswordRef: "secret:hub-directory" }).realm).toBe("corp");
  });

  it("refuses plaintext ldap://, with or without StartTLS, and any other scheme", () => {
    for (const bad of [{ url: "ldap://directory.test:389" }, { url: "ldap://directory.test:389", startTls: true }, { url: "ldapi:///" }, { url: "https://directory.test" }]) {
      expect(() => resolveDirectoryConfig({ ...base, ...bad })).toThrow(HubDirectoryConfigError);
    }
    expect(() => resolveDirectoryConfig({ ...base, url: "ldap://directory.test:389" })).toThrow(/plaintext/);
  });

  it("has no setting that turns certificate verification off: unknown keys are refused", () => {
    for (const extra of [{ rejectUnauthorized: false }, { tlsOptions: { rejectUnauthorized: false } }, { insecure: true }, { startTls: false }]) {
      expect(() => resolveDirectoryConfig({ ...base, ...extra })).toThrow(/unknown setting/);
    }
  });

  it("checks the realm, url shape, CA text, DNs and timeout", () => {
    for (const bad of [
      { realm: "Corp" }, { realm: "1corp" }, { realm: "corp/x" }, { realm: "a".repeat(65) }, { realm: "" },
      { url: "ldaps://user:pw@directory.test" }, { url: "ldaps://directory.test/dc=x" }, { url: "ldaps://directory.test?x" },
      { caPem: "not a cert" }, { baseDn: "dc=x\n" }, { timeoutMs: 100 }, { timeoutMs: 60_000 }, { profile: "novell" },
      { loginAttribute: "uid)(x" }, { userFilter: "objectClass=person" },
    ]) {
      expect(() => resolveDirectoryConfig({ ...base, ...bad }), JSON.stringify(bad)).toThrow(HubDirectoryConfigError);
    }
    expect(resolveDirectoryConfig({ ...base, realm: "corp_main-2" }).realm).toBe("corp_main-2");
  });

  it("refuses to start without the service account password", () => {
    expect(() => createHubDirectory(base, { bindPassword: "" })).toThrow(HubDirectoryConfigError);
    expect(() => createHubDirectory(base, {} as never)).toThrow(HubDirectoryConfigError);
  });
});

describe("hub directory identity helpers", () => {
  // The textbook example: GUID {6F9619FF-8B86-D011-B42D-00C04FC964FF} is stored as these bytes.
  const bytes = Buffer.from("ff19966f868b11d0b42d00c04fc964ff", "hex");
  it("decodes objectGUID bytes to the usual text form and back", () => {
    expect(guidBytesToString(bytes)).toBe("6f9619ff-8b86-d011-b42d-00c04fc964ff");
    expect(guidStringToBytes("6f9619ff-8b86-d011-b42d-00c04fc964ff")).toEqual(bytes);
    expect(guidBytesToString(bytes.subarray(0, 15))).toBeUndefined();
    expect(guidStringToBytes("not-a-guid")).toBeUndefined();
  });

  it("builds an exact object-id match (raw GUID bytes), never one from a login", () => {
    expect(objectIdMatch("ad", "6f9619ff-8b86-d011-b42d-00c04fc964ff")).toEqual({ attribute: "objectGUID", value: bytes });
    expect(objectIdMatch("openldap", "1463aac8-6aba-45fa-a172-f4a06ffa16ec")).toEqual({ attribute: "entryUUID", value: "1463aac8-6aba-45fa-a172-f4a06ffa16ec" });
    for (const bad of ["alice", "*", "1463AAC8-6ABA-45FA-A172-F4A06FFA16EC", "1463aac8-6aba-45fa-a172-f4a06ffa16ec)(uid=*"]) {
      expect(objectIdMatch("openldap", bad)).toBeUndefined();
      expect(objectIdMatch("ad", bad)).toBeUndefined();
    }
  });

  it("escapes filter values", () => {
    expect(escapeFilterValue("a*(b)\\c\u0000")).toBe("a\\2a\\28b\\29\\5cc\\00");
  });

  it("reads the object id only from the id attribute", () => {
    expect(readObjectId("openldap", { entryUUID: "1463AAC8-6ABA-45FA-A172-F4A06FFA16EC", uid: "alice" })).toBe("1463aac8-6aba-45fa-a172-f4a06ffa16ec");
    expect(readObjectId("openldap", { uid: "alice" })).toBeUndefined();
    expect(readObjectId("ad", { objectGUID: bytes })).toBe("6f9619ff-8b86-d011-b42d-00c04fc964ff");
    expect(readObjectId("ad", { objectGUID: "6f9619ff-8b86-d011-b42d-00c04fc964ff" })).toBeUndefined();
  });

  it("knows disabled and expired accounts", () => {
    const now = Date.UTC(2026, 10, 5);
    const filetime = (ms: number) => String((BigInt(ms) + 11_644_473_600_000n) * 10_000n);
    expect(isDisabled("ad", { userAccountControl: "512" }, now)).toBe(false);
    expect(isDisabled("ad", { userAccountControl: "514" }, now)).toBe(true);
    expect(isDisabled("ad", {}, now)).toBe(true);
    expect(isDisabled("ad", { userAccountControl: "512", accountExpires: "0" }, now)).toBe(false);
    expect(isDisabled("ad", { userAccountControl: "512", accountExpires: "9223372036854775807" }, now)).toBe(false);
    expect(isDisabled("ad", { userAccountControl: "512", accountExpires: filetime(now - 1000) }, now)).toBe(true);
    expect(isDisabled("ad", { userAccountControl: "512", accountExpires: filetime(now + 86_400_000) }, now)).toBe(false);
    expect(isDisabled("openldap", { pwdAccountLockedTime: "000001010000Z" }, now)).toBe(true);
    expect(isDisabled("openldap", { pwdAccountLockedTime: "20261105000000Z" }, now)).toBe(false); // temporary: the server enforces it
    expect(isDisabled("openldap", {}, now)).toBe(false);
  });
});

describe("hub directory fails closed without a directory", () => {
  it("refuses empty or malformed input before touching the network", async () => {
    const r = await recorder("silent");
    const dir = createHubDirectory({ ...base, url: `ldaps://127.0.0.1:${r.port}`, timeoutMs: 500 }, secrets);
    for (const [login, password] of [["alice", ""], ["", PASSWORD], [" alice", PASSWORD], ["al\nice", PASSWORD], ["a".repeat(257), PASSWORD], ["alice", "x".repeat(1025)]]) {
      expect(await dir.signIn(login!, password!)).toEqual({ ok: false, reason: "bad-input" });
    }
    expect(r.connections).toBe(0);
  });

  it("an unreachable directory refuses sign-in and eligibility", async () => {
    const r = await recorder("close");
    const port = r.port;
    await new Promise((res) => r.server.close(res));
    const dir = createHubDirectory({ ...base, url: `ldaps://127.0.0.1:${port}`, timeoutMs: 500 }, secrets);
    expect(await dir.signIn("alice", PASSWORD)).toEqual({ ok: false, reason: "unavailable" });
    expect(await dir.checkEligibility({ realm: "corp", objectId: "1463aac8-6aba-45fa-a172-f4a06ffa16ec" })).toEqual({ eligible: false, reason: "unavailable" });
  });

  it("a server that accepts but never answers times out as unavailable", async () => {
    const r = await recorder("silent");
    const dir = createHubDirectory({ ...base, url: `ldaps://127.0.0.1:${r.port}`, timeoutMs: 500 }, secrets);
    const started = performance.now();
    expect(await dir.signIn("alice", PASSWORD)).toEqual({ ok: false, reason: "unavailable" });
    expect(await dir.checkEligibility({ realm: "corp", objectId: "1463aac8-6aba-45fa-a172-f4a06ffa16ec" })).toEqual({ eligible: false, reason: "unavailable" });
    expect(performance.now() - started).toBeLessThan(5000);
  });

  it("a plaintext server never sees a password: the only bytes sent are a TLS handshake", async () => {
    const r = await recorder("close");
    const dir = createHubDirectory({ ...base, url: `ldaps://127.0.0.1:${r.port}`, timeoutMs: 500 }, secrets);
    expect(await dir.signIn("alice", PASSWORD)).toEqual({ ok: false, reason: "unavailable" });
    const sent = Buffer.concat(r.bytes);
    expect(r.connections).toBeGreaterThan(0);
    for (const chunk of r.bytes) expect(chunk[0]).toBe(0x16); // TLS handshake record
    expect(sent.includes(Buffer.from(PASSWORD))).toBe(false);
    expect(sent.includes(Buffer.from(secrets.bindPassword))).toBe(false);
  });

  it("a key from another realm or a non-UUID id is gone without a lookup", async () => {
    const r = await recorder("silent");
    const dir = createHubDirectory({ ...base, url: `ldaps://127.0.0.1:${r.port}`, timeoutMs: 500 }, secrets);
    expect(await dir.checkEligibility({ realm: "other", objectId: "1463aac8-6aba-45fa-a172-f4a06ffa16ec" })).toEqual({ eligible: false, reason: "gone" });
    expect(await dir.checkEligibility({ realm: "corp", objectId: "alice" })).toEqual({ eligible: false, reason: "gone" });
    expect(r.connections).toBe(0);
  });

  it("after close every call refuses", async () => {
    const r = await recorder("silent");
    const dir = createHubDirectory({ ...base, url: `ldaps://127.0.0.1:${r.port}`, timeoutMs: 500 }, secrets);
    await dir.close();
    expect(await dir.signIn("alice", PASSWORD)).toEqual({ ok: false, reason: "unavailable" });
    expect(await dir.checkEligibility({ realm: "corp", objectId: "1463aac8-6aba-45fa-a172-f4a06ffa16ec" })).toEqual({ eligible: false, reason: "unavailable" });
    expect(r.connections).toBe(0);
  });
});

describe("the LDAP client stays out of non-Hub installs", () => {
  it("src/ never imports ldapts statically (type-only imports are erased)", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|js|mjs|cjs)$/.test(name)) {
          const text = readFileSync(p, "utf8");
          if (/^\s*import\s+(?!type\b)[^;]*from\s+["']ldapts["']/m.test(text) || /require\(\s*["']ldapts["']\s*\)/.test(text)) offenders.push(p);
        }
      }
    };
    walk(join(__dirname, "..", "src"));
    expect(offenders).toEqual([]);
    expect(readFileSync(join(__dirname, "..", "src", "hub", "directory", "directory.ts"), "utf8")).toMatch(/import\("ldapts"\)/);
  });
});
