/** Inert controller boundaries. Real SQL/HTTPS issuance and restoration live in hub-compose. */
import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createHubDirectorySettingsControl } from "../src/hub/settings-directory-control.js";
import { HubSettingsError, type HubDirectorySettingsWriter } from "../src/hub/settings-commit.js";
import type { HubMountedDirectory } from "../src/hub/settings-directory-runtime.js";
import type { HubDirectoryProofContext } from "../src/hub/settings-directory-proof.js";
import * as certificates from "../src/hub/init/directory-certificate.js";
import { BIND_PASSWORD_REF } from "../src/hub/init/layout.js";

function fixture() {
  const hubId = randomUUID(), admin = { realm: "corp", objectId: randomUUID() };
  let live = true, time = 1000, physical = 0, probeGate: (() => Promise<void>) | undefined;
  const person = { key: admin, login: "fixture-admin", displayName: "Fixture Admin", dn: "uid=fixture,dc=example,dc=test", groups: [] };
  const directory = { realm: "corp", signIn: vi.fn(async () => ({ ok: true as const, person })),
    checkEligibility: vi.fn(async () => ({ eligible: true as const, person })), close: vi.fn(async () => {}) };
  const config = { realm: "corp", profile: "openldap" as const, url: "ldaps://old.example.test", baseDn: "dc=example,dc=test", bindDn: "cn=service,dc=example,dc=test", bindPasswordRef: BIND_PASSWORD_REF };
  const source = { directory, config, administrator: admin, groups: [], epoch: 0, image: "a".repeat(64), bindPassword: "Dummy-fixture-service-only", current: () => live };
  const decision = { hubId, inspect: () => ({ operationId: null, directoryEpoch: 0, transportRevision: 0, authorizationVersion: 0, policySha: "a".repeat(64) }) };
  const read = vi.fn(async <T>(_person: typeof admin, work: () => Promise<T>) => { physical++; try { return await work(); } finally { physical--; } });
  const sessions = { recentAuthentication: vi.fn(() => time), prepareDirectoryRotation: vi.fn(), completeDirectoryRotation: vi.fn() };
  const mounted = { current: () => live, decision, source: () => source, withDirectoryRead: read, sessions: () => sessions } as unknown as HubMountedDirectory;
  const prepare = vi.fn<HubDirectorySettingsWriter["prepare"]>(() => ({ ref: "fixture-writer-ref", expiresAt: 301000 }));
  const commit = vi.fn<HubDirectorySettingsWriter["commit"]>(() => { throw new HubSettingsError("stale"); });
  const writer = { prepare, commit } as unknown as HubDirectorySettingsWriter;
  const candidate = vi.fn(() => ({ ...directory, signIn: vi.fn(async () => { throw Error("personal credentials reached candidate"); }) }));
  const control = createHubDirectorySettingsControl({ hubId, mounted: () => mounted, writer: () => writer,
    withDecision: async work => work(mounted.decision), remount: async () => {}, current: () => live, now: () => time,
    createDirectory: candidate, probeTls: async () => { await probeGate?.(); return "A".repeat(64); } });
  const context: HubDirectoryProofContext = { actor: { kind: "hub-administrator", person: { ...admin }, sessionId: "fixture-session", requestId: randomUUID() }, current: () => live };
  const request = () => { const { realm: _realm, profile: _profile, bindPasswordRef: _ref, ...editable } = config;
    return { directory: { ...editable, url: "ldaps://next.example.test" }, bindPassword: "Dummy-next-service-only" }; };
  return { control, source, context, request, mounted, decision, candidate, prepare, commit, read, sessions, directory,
    stop: () => { live = false; }, tick: (n: number) => { time += n; }, gate: (work: () => Promise<void>) => { probeGate = work; }, get physical() { return physical; } };
}

describe("shared AD settings control", () => {
  it("returns editable connection values but never the bind password or its reference", async () => {
    const r = fixture();
    try {
      expect(r.control.read(r.context)).toEqual({ directory: { realm: "corp", profile: "openldap", url: "ldaps://old.example.test",
        baseDn: "dc=example,dc=test", bindDn: "cn=service,dc=example,dc=test" }, bindPasswordSet: true, reauthentication: "recent", epoch: 0 });
      expect(r.directory.checkEligibility).not.toHaveBeenCalled(); // The listener already acquired admin authority; read does not spend another slot.
      r.sessions.recentAuthentication.mockReturnValue(1000); r.tick(300_000);
      expect(r.control.read(r.context).reauthentication).toBe("required");
      expect(JSON.stringify(r.control.read(r.context))).not.toContain(r.source.bindPassword);
      r.source.epoch = 7; expect(r.control.read(r.context).epoch).toBe(7);
    } finally { await r.control.close(); }
  });
  it.each(["actor", "hub", "lifetime"])("refuses a mismatched %s even for a direct read", async part => {
    const r = fixture();
    if (part === "actor" && r.context.actor.kind === "hub-administrator") r.context.actor.person.objectId = randomUUID();
    if (part === "hub") r.decision.hubId = randomUUID();
    if (part === "lifetime") r.stop();
    try { expect(() => r.control.read(r.context)).toThrow(); expect(r.prepare).not.toHaveBeenCalled(); }
    finally { await r.control.close(); }
  });
  it.each(["actor", "changes", "recipients", "reference", "realm"])("refuses caller-selected %s before probing or writing", async part => {
    const r = fixture(), input: any = r.request();
    if (part === "actor") input.actor = r.context.actor;
    if (part === "changes") input.changes = ["query"];
    if (part === "recipients") input.recipients = [{ kind: "person", person: { realm: "corp", objectId: randomUUID() } }];
    if (part === "reference") input.directory.bindPasswordRef = "foreign-reference";
    if (part === "realm") input.directory.realm = "foreign";
    try {
      expect(() => r.control.prepare(input, r.context)).toThrow("invalid"); expect(r.read).not.toHaveBeenCalled(); expect(r.prepare).not.toHaveBeenCalled();
    } finally { await r.control.close(); }
  });
  it("derives immutable notice recipients and changed-field enums for the same writer", async () => {
    const r = fixture(), input = r.request();
    try {
      const draft = await r.control.prepare(input, r.context);
      await expect(r.control.apply({ ref: draft.ref, confirmation: draft.trust!.challenge },
        { actor: { kind: "host-owner", sessionId: "host", requestId: randomUUID() }, current: () => true })).rejects.toThrow();
      // The admin's own valid attempt, with a rotation capability, reaches the existing writer rather than a new writer.
      const rotation = { discard: vi.fn() }, draft2 = await r.control.prepare(input, r.context);
      await expect(r.control.apply({ ref: draft2.ref, confirmation: draft2.trust!.challenge }, r.context,
        { capture: () => { throw new HubSettingsError("stale"); }, rotation })).rejects.toMatchObject({ code: "stale" });
      expect(r.prepare).toHaveBeenCalledOnce(); expect(r.prepare.mock.calls[0]![0]).toMatchObject({ changes: ["server", "secret"],
        recipients: [{ kind: "host", sink: "owner-needs-you" }, { kind: "person", person: r.source.administrator }] });
      expect(r.commit).not.toHaveBeenCalled(); expect(rotation.discard).toHaveBeenCalled();
    } finally { await r.control.close(); }
  });
  it("snapshots nested candidate and actor before the scheduled preparation starts", async () => {
    const r = fixture(), input = r.request(), actor = structuredClone(r.context.actor);
    try {
      const prepared = r.control.prepare(input, r.context);
      input.directory.url = "ldaps://replacement.example.test";
      if (r.context.actor.kind === "hub-administrator") r.context.actor.person.objectId = randomUUID();
      const draft = await prepared;
      expect(draft.trust?.server).toBe("ldaps://next.example.test:636");
      await r.control.test({ ref: draft.ref, confirmation: draft.trust!.challenge }, { ...r.context, actor });
      expect(r.candidate).toHaveBeenCalledWith(expect.objectContaining({ url: "ldaps://next.example.test" }),
        { bindPassword: "Dummy-next-service-only" }, { expectedServerFingerprint: "A".repeat(64) });
    } finally { await r.control.close(); }
  });
  it.each(["inspect","fetch"] as const)("Stop drains physical CA %s through the shared controller",async mode=>{
    let release!:()=>void,enter!:()=>void;const held=new Promise<void>(r=>{release=r;}),entered=new Promise<void>(r=>{enter=r;});
    const inspect=vi.spyOn(certificates,"inspectDirectoryCertificate").mockImplementation(async url=>{if(mode==="inspect"){enter();await held;}return {url,leafPem:"inert-leaf",chain:[],certificate:{fingerprint256:"AA".repeat(32),subject:"Fixture",issuer:"Root",validTo:"fixture"}};});
    const fetch=vi.spyOn(certificates,"fetchDirectoryCa").mockImplementation(async()=>{enter();await held;return {pem:"inert-public-ca",certificates:[]};});
    const r=fixture();let pending:Promise<unknown>|undefined,closing:Promise<void>|undefined;
    try{
      if(mode==="inspect")pending=r.control.inspectCa({url:"ldaps://next.example.test"},r.context);
      else{const p=await r.control.inspectCa({url:"ldaps://next.example.test"},r.context);pending=r.control.fetchCa({ref:p.ref,fingerprint:p.certificate.fingerprint256},r.context);}
      void pending.catch(()=>{});await entered;expect(r.physical).toBe(1);
      let closed=false;closing=r.control.close().then(()=>{closed=true;});await new Promise<void>(resolve=>setImmediate(resolve));
      expect(closed).toBe(false);expect(r.physical).toBe(1);release();await expect(pending).rejects.toThrow();await closing;
      expect(r.physical).toBe(0);expect(r.prepare).not.toHaveBeenCalled();
    }finally{release();await pending?.catch(()=>{});await closing;await r.control.close();inspect.mockRestore();fetch.mockRestore();}
  });
  it("Stop retains shared-pool physical work and fences the held preparation before any writer effect", async () => {
    const r = fixture(); let release!: () => void, enter!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { enter = resolve; });
    r.gate(async () => { enter(); await wait; });
    const preparing = r.control.prepare(r.request(), r.context); void preparing.catch(() => {}); await entered;
    let closed = false; const closing = r.control.close().then(() => { closed = true; });
    try {
      await new Promise(resolve => setImmediate(resolve)); expect(closed).toBe(false); expect(r.physical).toBe(1);
      release(); await expect(preparing).rejects.toThrow(); await closing;
      expect(r.physical).toBe(0); expect(r.prepare).not.toHaveBeenCalled(); expect(r.candidate).not.toHaveBeenCalled();
      expect(() => r.control.read(r.context)).toThrow();
    } finally { release(); await closing; }
  });
});
