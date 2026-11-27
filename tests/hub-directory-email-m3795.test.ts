/** Actual directory driver through inert LDAP/TLS seams plus local Hub HTTP/session/SQL fixtures; no live directory/account. */
import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ searches: [] as any[], binds: [] as any[], tls: [] as any[], responses: [] as any[], close: 0, afterSearch: undefined as (() => void) | undefined, answer: undefined as ((options: any) => any[]) | undefined, userWait: undefined as Promise<void> | undefined }));
vi.mock("node:tls", async original => ({ ...await original<typeof import("node:tls")>(),
  connect: (options: any) => { f.tls.push(options); return { authorized: true, encrypted: true, destroyed: false }; },
}));
vi.mock("ldapts", () => {
  class InvalidCredentialsError extends Error {}
  return { InvalidCredentialsError,
  SizeLimitExceededError: class extends Error {},
  Client: class {
    isConnected = false;
    constructor(private options: any) {}
    async bind(dn: string, password: string) { if (!this.isConnected) { this.options.createSecureConnection(); this.isConnected = true; } f.binds.push({ dn, password }); if (password === "held-wrong") await f.userWait; if (password === "wrong" || password === "held-wrong") throw new InvalidCredentialsError(); }
    async search(base: string, options: any) { f.searches.push({ base, ...options }); f.afterSearch?.(); const value = f.answer ? f.answer(options) : f.responses.shift(); if (value instanceof Error) throw value; return { searchEntries: value ?? [] }; }
    async unbind() { f.close++; this.isConnected = false; }
  },
  AndFilter: class { constructor(readonly options: any) {} }, EqualityFilter: class { constructor(readonly options: any) {} },
  FilterParser: { parseString: (value: string) => value },
}; });
import { createHubDirectory } from "../src/hub/directory/index.js";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
const config = { realm: "demo", url: "ldaps://directory.example.test", baseDn: "dc=example,dc=test", bindDn: "cn=reader,dc=example,dc=test", profile: "ad" };
const guid = Buffer.from("ff19966f868b11d0b42d00c04fc964ff", "hex");
const entry = { dn: "cn=Alex,dc=example,dc=test", objectGUID: guid, sAMAccountName: "alex", userAccountControl: "512", mail: "alex@example.test" };
const other = { ...entry, dn: "cn=Other,dc=example,dc=test", objectGUID: Buffer.alloc(16, 3) };
const secret = "Dummy-service-only", pw = "Dummy-person-only";
const dir = (profile = "ad") => createHubDirectory({ ...config, profile }, { bindPassword: secret });
beforeEach(() => { f.searches.length = f.binds.length = f.tls.length = f.responses.length = 0; f.close = 0; f.afterSearch = undefined; f.answer = undefined; f.userWait = undefined; });
describe("AD sign-in exact email and UPN resolution M3795", () => {
  it.each(["alex@example.test", "alex@upn.example.test"])("resolves %s to the same GUID and binds only the selected DN", async login => {
    f.responses.push([], [entry], [entry]); const d = dir();
    expect(await d.signIn(login, pw)).toMatchObject({ ok: true, person: { key: { realm: "demo", objectId: "6f9619ff-8b86-d011-b42d-00c04fc964ff" }, login: "alex" } });
    expect(f.searches[1].filter).toContain(`(|(userPrincipalName=${login})(mail=${login}))`);
    expect(f.searches[1]).toMatchObject({ sizeLimit: 2, derefAliases: "never" });
    expect(f.binds).toEqual([{ dn: config.bindDn, password: secret }, { dn: entry.dn, password: pw }]);
    expect(f.tls).toHaveLength(2); expect(f.tls.every(x => x.rejectUnauthorized === true)).toBe(true);
    expect(f.close).toBe(2); await d.close();
  });
  it("keeps account-name matching first without alias lookup or password retry", async () => {
    f.responses.push([entry], [entry]); expect(await dir().signIn("alex", pw)).toMatchObject({ ok: true });
    expect(f.searches).toHaveLength(2); expect(f.searches[0].filter).toContain("(sAMAccountName=alex)"); expect(f.binds).toHaveLength(2);
  });
  it.each([[[], "invalid-credentials"], [[entry, other], "invalid-credentials"], [[{ ...entry, userAccountControl: "514" }], "not-eligible"]])("refuses missing, ambiguous or disabled alias before a personal bind", async (found, reason) => {
    f.responses.push([], found); expect(await dir().signIn("alex@example.test", pw)).toEqual({ ok: false, reason }); expect(f.binds).toHaveLength(1);
  });
  it("does not fallback after an ambiguous or disabled primary match", async () => {
    for (const found of [[entry, other], [{ ...entry, userAccountControl: "514" }]]) {
      f.responses.push(found); const before = f.searches.length;
      expect((await dir().signIn("alex", pw)).ok).toBe(false); expect(f.searches.length - before).toBe(1);
    }
  });
  it("escapes alias assertions without stripping @ or using substring matches", async () => {
    const login = "a*)(mail=*)@example.test"; f.responses.push([], []);
    expect(await dir().signIn(login, pw)).toEqual({ ok: false, reason: "invalid-credentials" });
    expect(f.searches[1].filter).toContain("(|(userPrincipalName=a\\2a\\29\\28mail=\\2a\\29@example.test)(mail=a\\2a\\29\\28mail=\\2a\\29@example.test))");
  });
  it("rechecks disabled state after the alias password bind", async () => {
    f.responses.push([], [entry], [{ ...entry, userAccountControl: "514" }]);
    expect(await dir().signIn("alex@example.test", pw)).toEqual({ ok: false, reason: "not-eligible" }); expect(f.binds).toHaveLength(2);
  });
  it("leaves OpenLDAP email handling unchanged", async () => {
    f.responses.push([]); expect(await dir("openldap").signIn("alex@example.test", pw)).toEqual({ ok: false, reason: "invalid-credentials" });
    expect(f.searches).toHaveLength(1); expect(f.searches[0].filter).toBe("(&(objectClass=person)(uid=alex@example.test))");
  });
  it("does not expand initialization lookup", async () => {
    f.responses.push([]); expect(await dir().lookupForInitialization!("alex@example.test")).toEqual({ ok: false, reason: "not-found" }); expect(f.searches).toHaveLength(1);
  });
});

it("3+ directory matches use the same refusal, with no personal bind", async () => {
  const { SizeLimitExceededError } = await import("ldapts");
  f.responses.push([], new SizeLimitExceededError("synthetic bound"));
  expect(await dir().signIn("alex@example.test", pw)).toEqual({ ok: false, reason: "invalid-credentials" }); expect(f.binds).toHaveLength(1);
});

it("HTTP failures are generic and five attempts still consume the existing limit", async () => {
  const r = await s3bRig({ directory: dir() });
  try {
    for (let i = 0; i < 5; i++) {
      f.responses.push([], i % 2 ? [entry, other] : []);
      const result = await r.signIn("alex@example.test"); expect(result.status).toBe(403); expect(result.body).toMatchObject({ code: "denied" });
    }
    const before = f.searches.length; expect((await r.signIn("alex@example.test")).status).toBe(429); expect(f.searches).toHaveLength(before);
    expect(r.db.prepare("SELECT COUNT(*) n FROM hub_people").get()).toEqual({ n: 0 });
  } finally { await r.close(); }
});
it("account name, UPN and mail produce one real Hub person row", async () => {
  const r = await s3bRig({ directory: dir() });
  try {
    for (const login of ["alex", "alex@upn.example.test", "alex@example.test"]) {
      f.responses.push(...(login === "alex" ? [[entry], [entry]] : [[], [entry], [entry]]));
      expect((await r.signIn(login)).status).toBe(200);
    }
    expect(r.db.prepare("SELECT realm,object_id,login_label FROM hub_people").all()).toEqual([{ realm: "demo", object_id: "6f9619ff-8b86-d011-b42d-00c04fc964ff", login_label: "alex" }]);
  } finally { await r.close(); }
});

it("OpenLDAP ambiguity keeps its existing unavailable outcome", async () => {
  f.responses.push([entry, other]); expect(await dir("openldap").signIn("alex", pw)).toEqual({ ok: false, reason: "unavailable" }); expect(f.searches).toHaveLength(1);
});

async function passwordAttempt(r: Awaited<ReturnType<typeof s3bRig>>, login: string, password = "wrong") {
  const response = await fetch(r.base + "/hub/v1/session", { method: "POST", headers: { "Content-Type": "application/json", Origin: r.config.webOrigin }, body: JSON.stringify({ login, password }) });
  return { status: response.status, body: await response.json() };
}
it("shares five failed password attempts across account name, UPN and mail", async () => {
  let now = 1_800_000_000_000;
  const r = await s3bRig({ directory: dir(), now: () => now });
  try {
    const names = ["alex", "alex@upn.example.test", "alex@example.test"];
    for (let i = 0; i < 5; i++) {
      const login = names[i % 3]!; f.responses.push(...(login === "alex" ? [[entry]] : [[], [entry]]));
      expect(await passwordAttempt(r, login)).toMatchObject({ status: 403, body: { code: "denied" } });
    }
    const before = f.binds.filter(b => b.dn === entry.dn).length; f.responses.push([], [entry]);
    const refused = await passwordAttempt(r, names[2]!); expect(refused.status).toBe(429); expect(JSON.stringify(refused.body)).not.toContain("6f9619ff");
    expect(f.binds.filter(b => b.dn === entry.dn)).toHaveLength(before);
    now += 5 * 60_000 + 1; f.responses.push([], [entry]);
    expect((await passwordAttempt(r, names[2]!)).status).toBe(403); expect(f.binds.filter(b => b.dn === entry.dn)).toHaveLength(before + 1);
  } finally { await r.close(); }
});

it("a resolved-account refusal happens before a personal bind and carries no identity DTO", async () => {
  f.responses.push([], [entry]); const gate = vi.fn((_person: { realm: string; objectId: string }) => false);
  expect(await dir().signIn("alex@example.test", pw, gate)).toEqual({ ok: false, reason: "backpressure" });
  expect(gate).toHaveBeenCalledExactlyOnceWith({ realm: "demo", objectId: "6f9619ff-8b86-d011-b42d-00c04fc964ff" });
  expect(Object.isFrozen(gate.mock.calls[0]![0])).toBe(true); expect(f.binds).toHaveLength(1);
});
it("disabled selections never acquire a password-attempt reservation", async () => {
  f.responses.push([], [{ ...entry, userAccountControl: "514" }]); const gate = vi.fn(() => true);
  expect(await dir().signIn("alex@example.test", pw, gate)).toEqual({ ok: false, reason: "not-eligible" }); expect(gate).not.toHaveBeenCalled();
});
it("a successful sign-in clears the shared failure budget", async () => {
  const r = await s3bRig({ directory: dir() });
  try {
    for (let i = 0; i < 4; i++) { f.responses.push([], [entry]); expect((await passwordAttempt(r, i % 2 ? "alex@example.test" : "alex@upn.example.test")).status).toBe(403); }
    f.responses.push([entry], [entry]); expect((await passwordAttempt(r, "alex", pw)).status).toBe(200);
    for (let i = 0; i < 5; i++) { f.responses.push([entry]); expect((await passwordAttempt(r, "alex")).status).toBe(403); }
    f.responses.push([], [entry]); expect((await passwordAttempt(r, "alex@example.test")).status).toBe(429);
  } finally { await r.close(); }
});
it("simultaneous alias binds reserve the same five-attempt capacity until their bind results settle", async () => {
  const r = await s3bRig({ directory: dir() });
  let release!: () => void; f.userWait = new Promise<void>(resolve => release = resolve);
  f.answer = options => typeof options.filter === "string" && options.filter.includes("(sAMAccountName=alex@") ? [] : [entry];
  const pending = ["alex", "alex@example.test", "alex@upn.example.test", "alex@example.test", "alex@upn.example.test"].map(login => passwordAttempt(r, login, "held-wrong"));
  try {
    await vi.waitFor(() => expect(f.binds.filter(b => b.dn === entry.dn)).toHaveLength(5));
    expect((await passwordAttempt(r, "alex@example.test")).status).toBe(429); expect(f.binds.filter(b => b.dn === entry.dn)).toHaveLength(5);
    release(); expect((await Promise.all(pending)).map(x => x.status)).toEqual([403, 403, 403, 403, 403]);
    expect((await passwordAttempt(r, "alex@upn.example.test")).status).toBe(429);
  } finally { release(); await Promise.allSettled(pending); await r.close(); }
});
