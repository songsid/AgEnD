/**
 * S-43 Hub directory sign-in against the fake directory (scripts/manual/hub-directory). Skipped unless
 * AGEND_HUB_RIG_ENV names the rig.env that `run.sh up` writes; CI's hub-directory job starts the rig and sets it.
 * Each test makes its own people (random names) as the rig admin, so the tests can run in any order and repeat.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { Attribute, Change, Client } from "ldapts";
import { createHubDirectory, HubDirectoryConfigError, type HubDirectory, type HubDirectoryDiagnostic } from "../src/hub/directory/index.js";
import { guidBytesToString } from "../src/hub/directory/profiles.js";

const envFile = process.env.AGEND_HUB_RIG_ENV;
const rig: Record<string, string> = {};
if (envFile && existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line);
    if (m) rig[m[1]!] = m[2]!;
  }
}
const enabled = rig.AGEND_HUB_RIG === "1";

const PEOPLE = "ou=people,dc=example,dc=test";
const pw = () => "Pw-" + randomBytes(12).toString("hex");
const tag = () => randomBytes(4).toString("hex");

describe.skipIf(!enabled)("hub directory sign-in against the fake directory (S-43)", () => {
  let admin: Client;
  let ca: string;
  const ldapsUrl = () => rig.AGEND_HUB_RIG_LDAPS_URL!;
  const port = () => Number(new URL(ldapsUrl()).port);
  const config = (over: Record<string, unknown> = {}) => ({
    realm: "rig", url: ldapsUrl(), caPem: ca, baseDn: rig.AGEND_HUB_RIG_BASE_DN, bindDn: rig.AGEND_HUB_RIG_BIND_DN, profile: "openldap", timeoutMs: 3000, ...over,
  });
  const diagnostics: HubDirectoryDiagnostic[] = [];
  const directory = (over: Record<string, unknown> = {}, bindPassword = rig.AGEND_HUB_RIG_BIND_PASSWORD!): HubDirectory =>
    createHubDirectory(config(over), { bindPassword }, { onDiagnostic: (d) => diagnostics.push(d) });

  beforeAll(async () => {
    ca = readFileSync(rig.AGEND_HUB_RIG_CA!, "utf8");
    admin = new Client({ url: ldapsUrl(), tlsOptions: { ca, rejectUnauthorized: true }, timeout: 5000, connectTimeout: 5000 });
    await admin.bind(rig.AGEND_HUB_RIG_ADMIN_DN!, rig.AGEND_HUB_RIG_ADMIN_PASSWORD!);
  });
  afterAll(async () => {
    await admin?.unbind();
  });
  afterEach(() => {
    diagnostics.length = 0;
  });

  async function addPerson(uid: string, password: string, extra: Record<string, string | string[]> = {}): Promise<string> {
    const dn = `uid=${uid},${PEOPLE}`;
    await admin.add(dn, { objectClass: "inetOrgPerson", uid, cn: `Test ${uid}`, sn: "Test", mail: `${uid}@example.test`, departmentNumber: "Engineering", userPassword: password, ...extra });
    return dn;
  }
  async function entryUUID(dn: string): Promise<string> {
    const { searchEntries } = await admin.search(dn, { scope: "base", attributes: ["entryUUID"] });
    return String(searchEntries[0]!.entryUUID);
  }
  async function addAdPerson(login: string, password: string, uac = "512"): Promise<{ dn: string; guid: Buffer }> {
    const dn = `cn=Test ${login},${PEOPLE}`;
    const guid = randomBytes(16);
    await admin.add(dn, {
      objectClass: ["inetOrgPerson", "fakeAdUser"], cn: `Test ${login}`, sn: "Test", sAMAccountName: login, userAccountControl: uac,
      department: "Engineering", objectGUID: guid as unknown as string, userPassword: password,
    });
    return { dn, guid };
  }
  const replace = (dn: string, type: string, values: string[]) => admin.modify(dn, new Change({ operation: "replace", modification: new Attribute({ type, values }) }));

  describe("local first-administrator lookup", () => {
    it("resolves an OpenLDAP identity with no user password or personal bind", async () => {
      const uid = `init-${tag()}`, dn = `uid=${uid},${PEOPLE}`;
      await admin.add(dn, { objectClass: "inetOrgPerson", uid, cn: "First Administrator", sn: "Test" });
      const d = directory(), selected = await d.lookupForInitialization!(uid);
      expect(selected).toMatchObject({ ok:true,person:{key:{realm:"rig",objectId:await entryUUID(dn)},login:uid} });
      expect(await d.signIn(uid,pw())).toEqual({ok:false,reason:"invalid-credentials"});
      await d.close();
    });
    it("uses decoded AD objectGUID and refuses disabled or ambiguous logins", async () => {
      const login = `init-${tag()}`, valid = await addAdPerson(login,pw());
      const d = directory({profile:"ad"});
      expect(await d.lookupForInitialization!(login)).toMatchObject({ok:true,person:{key:{realm:"rig",objectId:guidBytesToString(valid.guid)}}});
      await replace(valid.dn,"userAccountControl",["514"]);
      expect(await d.lookupForInitialization!(login)).toEqual({ok:false,reason:"not-eligible"});
      const other = await addAdPerson(`init-${tag()}`,pw()); await replace(other.dn,"sAMAccountName",[login]);
      expect(await d.lookupForInitialization!(login)).toEqual({ok:false,reason:"unavailable"});
      const third = await addAdPerson(`init-${tag()}`,pw()); await replace(third.dn,"sAMAccountName",[login]);
      // ldapts throws SizeLimitExceeded for 3+ matches rather than returning a partial successful selection.
      expect(await d.lookupForInitialization!(login)).toEqual({ok:false,reason:"unavailable"}); await d.close();
    });
    it("refuses unknown/filter-shaped accounts and an untrusted directory CA", async () => {
      const d = directory();
      for(const login of ["nobody", "*", "alice)(uid=*"]) expect(await d.lookupForInitialization!(login)).toEqual({ok:false,reason:"not-found"});
      const untrusted = directory({caPem:readFileSync(rig.AGEND_HUB_RIG_OTHER_CA!,"utf8")});
      expect(await untrusted.lookupForInitialization!("alice")).toEqual({ok:false,reason:"unavailable"});
      await d.close(); await untrusted.close();
    });
  });

  describe("openldap profile (entryUUID)", () => {
    it("signs in with the right password; the key is realm + entryUUID, never the login", async () => {
      const uid = `t-${tag()}`, password = pw();
      const dn = await addPerson(uid, password);
      const uuid = await entryUUID(dn);
      const res = await directory().signIn(uid, password);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.person.key).toEqual({ realm: "rig", objectId: uuid });
      expect(res.person).toMatchObject({ login: uid, dn, email: `${uid}@example.test`, department: "Engineering" });
      expect(JSON.stringify(res)).not.toContain(password);
      expect(await directory().checkEligibility(res.person.key)).toMatchObject({ eligible: true, person: { login: uid } });
    });

    it("a wrong password, an unknown login and an empty password are refused; the password never shows up anywhere", async () => {
      const uid = `t-${tag()}`, password = pw();
      await addPerson(uid, password);
      const wrong = pw();
      const dir = directory();
      expect(await dir.signIn(uid, wrong)).toEqual({ ok: false, reason: "invalid-credentials" });
      expect(await dir.signIn(`nobody-${tag()}`, password)).toEqual({ ok: false, reason: "invalid-credentials" });
      expect(await dir.signIn(uid, "")).toEqual({ ok: false, reason: "bad-input" });
      expect(JSON.stringify(diagnostics)).not.toContain(wrong);
      expect(JSON.stringify(diagnostics)).not.toContain(password);
    });

    it("filter metacharacters in a login match nothing", async () => {
      const dir = directory();
      for (const login of ["*", "alice)(uid=*", "a*", "*)(objectClass=*"]) {
        expect(await dir.signIn(login, rig.AGEND_HUB_RIG_SEED_PASSWORD!), login).toEqual({ ok: false, reason: "invalid-credentials" });
      }
    });

    it("the seed: alice signs in with her groups; bob (locked) is refused", async () => {
      const dir = directory();
      const alice = await dir.signIn("alice", rig.AGEND_HUB_RIG_SEED_PASSWORD!);
      expect(alice).toMatchObject({ ok: true, person: { login: "alice", groups: ["cn=engineering,ou=groups,dc=example,dc=test"] } });
      expect(await dir.signIn("bob", rig.AGEND_HUB_RIG_SEED_PASSWORD!)).toEqual({ ok: false, reason: "not-eligible" });
    });

    it("a disabled account is refused at sign-in, and an existing key turns ineligible at the next request", async () => {
      const uid = `t-${tag()}`, password = pw();
      const dn = await addPerson(uid, password);
      const dir = directory();
      const res = await dir.signIn(uid, password);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      await replace(dn, "pwdAccountLockedTime", ["000001010000Z"]);
      expect(await dir.checkEligibility(res.person.key)).toEqual({ eligible: false, reason: "disabled" });
      expect(await dir.signIn(uid, password)).toEqual({ ok: false, reason: "not-eligible" });
    });

    it("a rename keeps the identity: the old key stays eligible and the new login signs in as the same person", async () => {
      const uid = `t-${tag()}`, renamed = `t-${tag()}`, password = pw();
      await addPerson(uid, password);
      const dir = directory();
      const before = await dir.signIn(uid, password);
      expect(before.ok).toBe(true);
      if (!before.ok) return;
      await admin.modifyDN(`uid=${uid},${PEOPLE}`, `uid=${renamed}`);
      expect(await dir.checkEligibility(before.person.key)).toMatchObject({ eligible: true, person: { login: renamed, dn: `uid=${renamed},${PEOPLE}` } });
      const after = await dir.signIn(renamed, password);
      expect(after).toMatchObject({ ok: true, person: { key: before.person.key, login: renamed } });
      expect(await dir.signIn(uid, password)).toEqual({ ok: false, reason: "invalid-credentials" });
    });

    it("a recreated account with the same login is a NEW person; the old key is gone", async () => {
      const uid = `t-${tag()}`, password = pw();
      const dn = await addPerson(uid, password);
      const dir = directory();
      const first = await dir.signIn(uid, password);
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      await admin.del(dn);
      expect(await dir.checkEligibility(first.person.key)).toEqual({ eligible: false, reason: "gone" });
      await addPerson(uid, password);
      const second = await dir.signIn(uid, password);
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.person.key.objectId).not.toBe(first.person.key.objectId);
      expect(second.person.login).toBe(first.person.login);
      expect(await dir.checkEligibility(first.person.key)).toEqual({ eligible: false, reason: "gone" });
      expect(await dir.checkEligibility(second.person.key)).toMatchObject({ eligible: true });
    });

    it("a wrong service-account password fails closed", async () => {
      const dir = directory({}, pw());
      expect(await dir.signIn("alice", rig.AGEND_HUB_RIG_SEED_PASSWORD!)).toEqual({ ok: false, reason: "unavailable" });
    });
  });

  describe("ad profile (objectGUID, userAccountControl)", () => {
    const ad = () => directory({ profile: "ad" });

    it("signs in; the key is the decoded objectGUID, and eligibility finds the person by its binary GUID", async () => {
      const login = `a${tag()}`, password = pw();
      const { guid } = await addAdPerson(login, password);
      const res = await ad().signIn(login, password);
      expect(res).toMatchObject({ ok: true, person: { key: { realm: "rig", objectId: guidBytesToString(guid) }, login, department: "Engineering" } });
      if (!res.ok) return;
      expect(await ad().checkEligibility(res.person.key)).toMatchObject({ eligible: true, person: { login } });
    });

    it("the disable bit and an expiry in the past refuse; the seed's frank is disabled and erin signs in", async () => {
      const login = `a${tag()}`, password = pw();
      const { dn } = await addAdPerson(login, password);
      const dir = ad();
      const res = await dir.signIn(login, password);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      await replace(dn, "userAccountControl", ["514"]);
      expect(await dir.checkEligibility(res.person.key)).toEqual({ eligible: false, reason: "disabled" });
      expect(await dir.signIn(login, password)).toEqual({ ok: false, reason: "not-eligible" });
      await replace(dn, "userAccountControl", ["512"]);
      await admin.modify(dn, new Change({ operation: "add", modification: new Attribute({ type: "accountExpires", values: [String((BigInt(Date.now() - 60_000) + 11_644_473_600_000n) * 10_000n)] }) }));
      expect(await dir.checkEligibility(res.person.key)).toEqual({ eligible: false, reason: "disabled" });
      expect(await dir.signIn("frank", rig.AGEND_HUB_RIG_SEED_PASSWORD!)).toEqual({ ok: false, reason: "not-eligible" });
      expect(await dir.signIn("erin", rig.AGEND_HUB_RIG_SEED_PASSWORD!)).toMatchObject({ ok: true, person: { login: "erin" } });
    });

    it("a machine account (objectClass computer) never signs in as a person", async () => {
      const login = `m${tag()}`, password = pw();
      await admin.add(`cn=Machine ${login},${PEOPLE}`, {
        objectClass: ["computer", "fakeAdUser"], cn: `Machine ${login}`, sn: "Machine", sAMAccountName: login, userAccountControl: "4096",
        objectGUID: randomBytes(16) as unknown as string, userPassword: password,
      });
      expect(await ad().signIn(login, password)).toEqual({ ok: false, reason: "invalid-credentials" });
    });

    it("a changed login keeps the identity; a recreated account gets a new one", async () => {
      const login = `a${tag()}`, renamed = `a${tag()}`, password = pw();
      const { dn } = await addAdPerson(login, password);
      const dir = ad();
      const first = await dir.signIn(login, password);
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      await replace(dn, "sAMAccountName", [renamed]);
      expect(await dir.signIn(renamed, password)).toMatchObject({ ok: true, person: { key: first.person.key } });
      await admin.del(dn);
      await addAdPerson(renamed, password);
      const second = await dir.signIn(renamed, password);
      expect(second.ok && second.person.key.objectId !== first.person.key.objectId).toBe(true);
      expect(await dir.checkEligibility(first.person.key)).toEqual({ eligible: false, reason: "gone" });
    });
  });

  describe("transport: verified LDAPS or nothing", () => {
    it("ldap:// (the rig's plaintext port, which WOULD accept a bind) is refused before any connection", () => {
      expect(() => directory({ url: rig.AGEND_HUB_RIG_LDAP_URL })).toThrow(HubDirectoryConfigError);
    });

    it("a certificate from another CA, or for another host name, is refused", async () => {
      const other = directory({ caPem: readFileSync(rig.AGEND_HUB_RIG_OTHER_CA!, "utf8") });
      expect(await other.signIn("alice", rig.AGEND_HUB_RIG_SEED_PASSWORD!)).toEqual({ ok: false, reason: "unavailable" });
      expect(diagnostics.at(-1)?.error).toMatch(/certificate/i);
      const noCa = directory({ caPem: undefined });
      expect(await noCa.signIn("alice", rig.AGEND_HUB_RIG_SEED_PASSWORD!)).toEqual({ ok: false, reason: "unavailable" });
      const wrongName = directory({ url: `ldaps://localhost:${port()}` }); // the certificate names directory.test and 127.0.0.1 only
      expect(await wrongName.signIn("alice", rig.AGEND_HUB_RIG_SEED_PASSWORD!)).toEqual({ ok: false, reason: "unavailable" });
      expect(diagnostics.at(-1)?.error).toMatch(/altnames|localhost/i);
    });

    describe("through a relay that can cut the line", () => {
      let relay: Server;
      let relayPort = 0;
      let target = 0;
      // cut: drop each connection right after the directory's first answer to application data (the bind result).
      let cut = false;
      // Bytes from connections accepted since the last reset only (an earlier test's closing unbind can still trickle in).
      let sent: Buffer[] = [];
      const open: Socket[] = [];
      beforeAll(async () => {
        relay = createServer((client) => {
          const upstream = connect(target, "127.0.0.1");
          open.push(client, upstream);
          const into = sent;
          let appData = false;
          client.on("data", (d) => {
            into.push(Buffer.from(d));
            if (d[0] === 0x17) appData = true;
            upstream.write(d);
          });
          upstream.on("data", (d) => {
            client.write(d);
            if (cut && appData) setImmediate(() => { client.destroy(); upstream.destroy(); });
          });
          client.on("error", () => upstream.destroy());
          upstream.on("error", () => client.destroy());
        });
        await new Promise<void>((res) => relay.listen(0, "127.0.0.1", res));
        relayPort = (relay.address() as { port: number }).port;
      });
      afterAll(async () => {
        for (const s of open) s.destroy();
        await new Promise((res) => relay.close(res));
      });

      it("works through the relay, then fails closed (sign-in and eligibility) once the directory is unreachable", async () => {
        target = port();
        const dir = directory({ url: `ldaps://127.0.0.1:${relayPort}` });
        const res = await dir.signIn("alice", rig.AGEND_HUB_RIG_SEED_PASSWORD!);
        expect(res.ok).toBe(true);
        if (!res.ok) return;
        target = 1; // nothing listens there: the directory is now unreachable
        expect(await dir.checkEligibility(res.person.key)).toEqual({ eligible: false, reason: "unavailable" });
        expect(await dir.signIn("alice", rig.AGEND_HUB_RIG_SEED_PASSWORD!)).toEqual({ ok: false, reason: "unavailable" });
        target = port();
        expect(await dir.checkEligibility(res.person.key)).toMatchObject({ eligible: true });
      });

      it("a connection lost after the service bind is not silently reopened: the operation fails closed", async () => {
        target = port();
        cut = true;
        try {
          const dir = directory({ url: `ldaps://127.0.0.1:${relayPort}` });
          expect(await dir.signIn("alice", rig.AGEND_HUB_RIG_SEED_PASSWORD!)).toEqual({ ok: false, reason: "unavailable" });
          // The cut lands on the service or the user connection, before the next request is written (our guard
          // refuses) or while it is in flight (the library reports the close): timing decides. Every one of those is a
          // refusal on the session's own connection. Without the guards, ldapts reconnects and runs the search
          // unbound, which ends in a directory error such as NoSuchObject instead (mutation-checked).
          expect(diagnostics.at(-1)?.error).toMatch(/refusing to reconnect|no verified TLS connection|Connection closed before message response/);
        } finally {
          cut = false;
        }
      });

      it("pointed at the plaintext port, only a TLS handshake goes out: no bind, no password", async () => {
        target = Number(new URL(rig.AGEND_HUB_RIG_LDAP_URL!).port);
        sent = [];
        const dir = directory({ url: `ldaps://127.0.0.1:${relayPort}` });
        expect(await dir.signIn("alice", rig.AGEND_HUB_RIG_SEED_PASSWORD!)).toEqual({ ok: false, reason: "unavailable" });
        expect(sent.length).toBeGreaterThan(0);
        for (const chunk of sent) expect(chunk[0]).toBe(0x16);
        const all = Buffer.concat(sent);
        expect(all.includes(Buffer.from(rig.AGEND_HUB_RIG_SEED_PASSWORD!))).toBe(false);
        expect(all.includes(Buffer.from(rig.AGEND_HUB_RIG_BIND_PASSWORD!))).toBe(false);
      });
    });
  });
});
