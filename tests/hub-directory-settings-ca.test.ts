/** CA-controller boundaries with inert inspection/fetch and a recorded shared physical pool. Wire is tested separately. */
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { X509Certificate, randomUUID } from "node:crypto";
import { directorySettingsRefusal } from "../src/hub/settings-directory-http.js";
import { createHubDirectorySettingsCa, HubDirectorySettingsCaError } from "../src/hub/settings-directory-ca.js";
import { directoryCaFixture, directoryCertificates } from "./support/hub-directory-ca-fixture.js";
import type { PersonKey } from "../src/hub/types.js";
import type { HubDirectoryProofContext, HubDirectoryProofSource } from "../src/hub/settings-directory-proof.js";

function refused(work:()=>unknown) { return ()=>{ const result=work(); if(result instanceof Promise)void result.catch(()=>{}); return result; }; }
function held() { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; }
function rig(wire = false) {
  let live = true, time = 1000, physical = 0, sourceHook: (() => void) | undefined;
  const admin = { realm: "corp", objectId: randomUUID() };
  const source = { directory: { realm: "corp", signIn: async () => ({ok:false,reason:"unavailable"}), checkEligibility: async () => ({eligible:false,reason:"unavailable"}), close: async()=>{} }, config: { realm: "corp", profile: "ad", url: "ldaps://old.example.test", baseDn: "DC=example,DC=test", bindDn: "CN=Reader" },
    administrator: admin, groups: [], bindPassword: "Dummy-old-service-only", epoch: 0, image: "a".repeat(64), current: () => live } as HubDirectoryProofSource;
  const inspect = vi.fn(async (url: string) => ({ url, leafPem: "inert-leaf-not-parsed", chain: [], certificate: { fingerprint256: "AA".repeat(32), subject: "Fixture", issuer: "Fixture Root", validTo: "fixture" } }));
  const fetch = vi.fn(async (_probe: unknown, _pin: string, _credentials?: {bindDn:string;password:string}) => ({ pem: "inert-public-ca", certificates: [] }));
  const pool = vi.fn((_subject: PersonKey) => {});
  const read = async <T>(subject: PersonKey, work: () => Promise<T>): Promise<T> => { pool(subject); physical++; try { return await work(); } finally { physical--; } };
  const ca = createHubDirectorySettingsCa({ source: () => { sourceHook?.(); return source; }, withDirectoryRead: read, now: () => time, ...(wire ? {} : { inspectCertificate: inspect, fetchCa: fetch }) });
  const ctx: HubDirectoryProofContext = { actor: { kind: "hub-administrator", person: { ...admin }, sessionId: "fixture-session", requestId: randomUUID() }, current: () => live };
  const inspectNow = () => ca.inspect({ url: "ldaps://next.example.test" }, ctx);
  return { ca, source, ctx, inspect, fetch, pool, inspectNow, now: (t: number) => { time = t; }, hook: (hook: () => void) => { sourceHook = hook; },
    revoke: () => { live = false; }, get physical() { return physical; } };
}

describe("settings CA probe authority", () => {
  it("normalizes the target and fetches once with only supplied service credentials in the shared pool", async () => {
    const r = rig();
    try {
      const p = await r.inspectNow(); expect(p.ref).toMatch(/^[A-Za-z0-9_-]{32}$/); expect(p.server).toBe("ldaps://next.example.test:636");
      expect(r.inspect).toHaveBeenCalledExactlyOnceWith(p.server); expect(r.fetch).not.toHaveBeenCalled();
      const input = { ref: p.ref, fingerprint: p.certificate.fingerprint256, bindDn: "CN=New Reader", bindPassword: "Dummy-new-service-only" };
      const done = r.ca.fetch(input, { ...r.ctx, actor: { ...r.ctx.actor, requestId: randomUUID() } }); input.bindPassword = "mutated";
      expect(await done).toMatchObject({ server: p.server, leafFingerprint: p.certificate.fingerprint256, caPem: "inert-public-ca" });
      expect(r.fetch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ url: p.server }), p.certificate.fingerprint256,
        { bindDn: "CN=New Reader", password: "Dummy-new-service-only" });
      expect(r.pool).toHaveBeenCalledTimes(2); expect(r.pool.mock.calls.every(call => call[0].objectId === r.source.administrator.objectId)).toBe(true);
      expect(r.physical).toBe(0); expect(refused(()=>r.ca.fetch(input, r.ctx))).toThrow("not-found");
    } finally { r.ca.close(); }
  });
  it("refuses a mismatched pin before another pool admission or credential-bearing call and consumes it", async () => {
    const r = rig(); try {
      const p = await r.inspectNow(); expect(refused(()=>r.ca.fetch({ ref: p.ref, fingerprint: "BB".repeat(32), bindDn: "CN=Reader", bindPassword: "Dummy-service-only" }, r.ctx))).toThrow("ca-trust");
      expect(r.pool).toHaveBeenCalledOnce(); expect(r.fetch).not.toHaveBeenCalled();
      expect(refused(()=>r.ca.fetch({ ref: p.ref, fingerprint: p.certificate.fingerprint256 }, r.ctx))).toThrow("not-found");
    } finally { r.ca.close(); }
  });
  it.each(["session", "person", "kind"])("another %s cannot consume the original actor's probe", async part => {
    const r = rig(); try {
      const p = await r.inspectNow(), ctx = structuredClone({ actor: r.ctx.actor });
      if (part === "session") ctx.actor.sessionId = "other-session";
      if (part === "person" && ctx.actor.kind === "hub-administrator") ctx.actor.person.objectId = randomUUID();
      if (part === "kind") ctx.actor = { kind: "host-owner", sessionId: r.ctx.actor.sessionId, requestId: randomUUID() };
      expect(refused(()=>r.ca.fetch({ ref: p.ref, fingerprint: p.certificate.fingerprint256 }, { ...r.ctx, ...ctx }))).toThrow("revoked");
      expect(r.fetch).not.toHaveBeenCalled(); await r.ca.fetch({ ref: p.ref, fingerprint: p.certificate.fingerprint256 }, r.ctx);
      expect(r.fetch).toHaveBeenCalledOnce();
    } finally { r.ca.close(); }
  });
  it.each(["image", "epoch", "directory", "expiry", "backwards", "late-clock", "initial-expiry", "initial-backwards"])("a changed %s cannot reuse a prior inspection", async part => {
    const r = rig(); try {
      const p = await r.inspectNow();
      if (part === "image") r.source.image = "b".repeat(64);
      if (part === "epoch") r.source.epoch++;
      if (part === "directory") r.source.directory = { ...r.source.directory };
      if (part === "expiry") r.now(p.expiresAt);
      if (part === "backwards") r.now(999);
      if (part === "late-clock") r.hook(() => r.now(p.expiresAt));
      if (part === "initial-expiry") { r.now(p.expiresAt); r.hook(() => r.now(1000)); }
      if (part === "initial-backwards") { r.now(999); r.hook(() => r.now(1000)); }
      expect(refused(()=>r.ca.fetch({ ref: p.ref, fingerprint: p.certificate.fingerprint256 }, r.ctx))).toThrow("revoked");
      expect(r.fetch).not.toHaveBeenCalled(); expect(r.pool).toHaveBeenCalledOnce();
    } finally { r.ca.close(); }
  });
  it.each(["image", "close"])("a held inspection retains physical occupancy until settlement after %s", async mode => {
    const r = rig(), entered = held(), resume = held();
    r.inspect.mockImplementation(async url => { entered.release(); await resume.promise; return { url, leafPem: "inert", chain: [], certificate: { fingerprint256: "AA".repeat(32), subject: "Fixture", issuer: "Fixture Root", validTo: "fixture" } }; });
    const pending = r.inspectNow(); void pending.catch(() => {});
    try { await entered.promise; expect(r.physical).toBe(1); if (mode === "close") r.ca.close(); else r.source.image = "b".repeat(64);
      expect(r.physical).toBe(1); resume.release(); await expect(pending).rejects.toThrow("revoked"); expect(r.physical).toBe(0);
    } finally { resume.release(); await pending.catch(() => {}); r.ca.close(); }
  });
  it("requires service credential fields together and exposes an actionable anonymous-read refusal",async()=>{
    const r=rig();try{
      const p=await r.inspectNow(),base={ref:p.ref,fingerprint:p.certificate.fingerprint256};
      expect(refused(()=>r.ca.fetch({...base,bindDn:"CN=Reader"},r.ctx))).toThrow("invalid");
      expect(refused(()=>r.ca.fetch({...base,bindPassword:"Dummy-service-only"},r.ctx))).toThrow("invalid");
      expect(r.pool).toHaveBeenCalledOnce();r.fetch.mockRejectedValueOnce(Error("directory_ca_auth_required"));
      const refusal=await r.ca.fetch(base,r.ctx).then(value=>({ok:true,value}),error=>({ok:false,code:error.code,message:error.message}));
      expect(refusal).toEqual({ok:false,code:"ca-auth-required",message:"ca-auth-required"});
      expect(r.fetch).toHaveBeenCalledExactlyOnceWith(expect.anything(),base.fingerprint,undefined);
    }finally{r.ca.close();}
  });
  it.each([["ca-invalid",400],["ca-trust",409],["ca-auth-required",403],["ca-unavailable",503],["ca-unsupported",409]] as const)("maps %s to a bounded %s without private error text",(code,status)=>{
    expect(directorySettingsRefusal(new HubDirectorySettingsCaError(code))).toEqual({code,status});
  });

  it("closes a held fetch without releasing physical occupancy or returning its CA early", async () => {
    const r = rig(), entered = held(), resume = held();
    r.fetch.mockImplementation(async () => { entered.release(); await resume.promise; return { pem: "inert-ca", certificates: [] }; });
    const p = await r.inspectNow(), pending = r.ca.fetch({ ref: p.ref, fingerprint: p.certificate.fingerprint256 }, r.ctx); void pending.catch(() => {});
    try { await entered.promise; r.ca.close(); expect(r.physical).toBe(1); resume.release(); await expect(pending).rejects.toThrow("revoked"); expect(r.physical).toBe(0); }
    finally { resume.release(); await pending.catch(() => {}); }
  });
  it("reserves the last retained-probe slot while an inspection is still physical",async()=>{
    const r=rig(),entered=held(),resume=held();let pending:Promise<unknown>|undefined,extra:Promise<unknown>|undefined;
    try{
      const existing=[];for(let i=0;i<31;i++)existing.push(await r.inspectNow());expect(existing).toHaveLength(31);
      r.inspect.mockImplementation(async url=>{entered.release();await resume.promise;return {url,leafPem:"inert",chain:[],certificate:{fingerprint256:"AA".repeat(32),subject:"Fixture",issuer:"Root",validTo:"fixture"}};});
      pending=r.inspectNow();await entered.promise;expect(r.physical).toBe(1);
      expect(refused(()=>{extra=r.inspectNow();void extra.catch(()=>{});})).toThrow("backpressure");
      expect(r.inspect).toHaveBeenCalledTimes(32);resume.release();await pending;
    }finally{resume.release();await pending?.catch(()=>{});await extra?.catch(()=>{});r.ca.close();}
  });
  it("snapshots the actor before a held inspection and keeps the original session's probe",async()=>{
    const r=rig(),entered=held(),resume=held(),owner={...r.ctx,actor:structuredClone(r.ctx.actor)};
    r.inspect.mockImplementation(async url=>{entered.release();await resume.promise;return {url,leafPem:"inert",chain:[],certificate:{fingerprint256:"AA".repeat(32),subject:"Fixture",issuer:"Root",validTo:"fixture"}};});
    const pending=r.inspectNow();void pending.catch(()=>{});
    try{await entered.promise;r.ctx.actor.sessionId="replacement-session";resume.release();const p=await pending.catch(()=>null);expect(p).not.toBeNull();
      await expect(r.ca.fetch({ref:p!.ref,fingerprint:p!.certificate.fingerprint256},owner)).resolves.toMatchObject({caPem:"inert-public-ca"});
    }finally{resume.release();await pending.catch(()=>{});r.ca.close();}
  });
  it.each([["directory_ca_invalid","ca-invalid"],["directory_ca_pin","ca-trust"],["directory_ca_auth_required","ca-auth-required"],
    ["directory_ca_expired","ca-trust"],["directory_ca_hostname","ca-trust"],["directory_ca_unsupported","ca-unsupported"],
    ["directory_ca_aia","ca-unsupported"],["Dummy-private-message","ca-unavailable"]] as const)("bounds %s as %s",async(message,code)=>{
    const r=rig();try{const p=await r.inspectNow();r.fetch.mockRejectedValueOnce(Error(message));
      await expect(r.ca.fetch({ref:p.ref,fingerprint:p.certificate.fingerprint256},r.ctx)).rejects.toMatchObject({code,message:code});
    }finally{r.ca.close();}
  });

  it("prunes probes from a superseded source before counting the limit",async()=>{
    const r=rig();try{
      const old: Awaited<ReturnType<typeof r.inspectNow>>[]=[];for(let i=0;i<32;i++)old.push(await r.inspectNow());expect(old).toHaveLength(32);
      r.source.image="b".repeat(64);
      const current=await Promise.resolve().then(r.inspectNow).catch(()=>null);expect(current).not.toBeNull();
      expect(current!.ref).toMatch(/^[A-Za-z0-9_-]{32}$/);expect(r.inspect).toHaveBeenCalledTimes(33);
      expect(refused(()=>r.ca.fetch({ref:old[0]!.ref,fingerprint:old[0]!.certificate.fingerprint256},r.ctx))).toThrow("not-found");
    }finally{r.ca.close();}
  });
  it("bounds retained probes and frees expired entries", async () => {
    const r = rig(); try {
      const rows = []; for (let i = 0; i < 32; i++) rows.push(await r.inspectNow()); expect(rows).toHaveLength(32);
      expect(refused(()=>r.inspectNow())).toThrow("backpressure"); expect(r.inspect).toHaveBeenCalledTimes(32);
      r.now(rows[0]!.expiresAt); expect((await r.inspectNow()).ref).toMatch(/^[A-Za-z0-9_-]{32}$/); expect(r.physical).toBe(0);
    } finally { r.ca.close(); }
  });
  it("refuses arbitrary targets/metadata in fetch and never exposes a private error", async () => {
    const r = rig(); try {
      expect(refused(()=>r.ca.inspect({ url: "ldaps://next.example.test", bindPassword: "Dummy-private" }, r.ctx))).toThrow("invalid");
      expect(refused(()=>r.ca.inspect({ url: "ldap://plain.example.test" }, r.ctx))).toThrow("invalid");
      const p = await r.inspectNow(); expect(refused(()=>r.ca.fetch({ ref: p.ref, fingerprint: p.certificate.fingerprint256, url: "ldaps://other.example.test" }, r.ctx))).toThrow("invalid");
      r.fetch.mockRejectedValueOnce(Error("Dummy-private-server-text"));
      await expect(r.ca.fetch({ ref: p.ref, fingerprint: p.certificate.fingerprint256 }, r.ctx)).rejects.toMatchObject({ code: "ca-unavailable", message: "ca-unavailable" });
      expect(refused(()=>r.ca.fetch({ ref: p.ref, fingerprint: p.certificate.fingerprint256 }, r.ctx))).toThrow("not-found");
    } finally { r.ca.close(); }
  });
});


describe("settings CA bootstrap with real CA-verified loopback LDAPS",()=>{
  let certs:ReturnType<typeof directoryCertificates>;
  beforeAll(()=>{certs=directoryCertificates();});afterAll(()=>certs.cleanup());
  it("inspects without application bytes and releases only public CA data after exact pinned service binds",async()=>{
    const r=rig(true),peer=await directoryCaFixture(certs.leaf,certs.ca,{requireBind:true});
    try{
      const first=await r.ca.inspect({url:peer.url},r.ctx);expect(peer.applicationBytes()).toBe(0);expect(peer.binds).toEqual([]);
      const rawBefore=peer.rawConnections();
      expect(refused(()=>r.ca.fetch({ref:first.ref,fingerprint:"BB".repeat(32),bindDn:"CN=Reader",bindPassword:"Dummy-explicit-service-only"},r.ctx))).toThrow("ca-trust");
      expect(peer.rawConnections()).toBe(rawBefore);expect(peer.binds).toEqual([]);
      const inspected=await r.ca.inspect({url:peer.url},r.ctx);
      const result=await r.ca.fetch({ref:inspected.ref,fingerprint:inspected.certificate.fingerprint256,bindDn:"CN=Reader",bindPassword:"Dummy-explicit-service-only"},r.ctx);
      expect(result.caPem).toBe(new X509Certificate(certs.ca).toString());expect(result.server).toBe(peer.url);
      expect(result.leafFingerprint).toBe(new X509Certificate(certs.leaf.cert).fingerprint256);
      expect(peer.binds).toEqual([{dn:"CN=Reader",password:"Dummy-explicit-service-only"}]);
      expect(JSON.stringify(result)).not.toContain("Dummy-");expect(JSON.stringify(peer.binds)).not.toContain(r.source.bindPassword);
      expect(r.pool).toHaveBeenCalledTimes(3);expect(r.physical).toBe(0);expect(r.fetch).not.toHaveBeenCalled();
    }finally{r.ca.close();await peer.close();}
  });
});
