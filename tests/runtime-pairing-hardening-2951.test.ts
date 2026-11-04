import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebSocket } from "ws";
import { afterEach, expect, it, vi } from "vitest";
import { RuntimeCoordinator } from "../src/runtime-coordinator.js";
import { RuntimeClient, rotateRuntimeCredentials, type RuntimeBridge } from "../src/runtime-client.js";
import { RuntimeClientStore } from "../src/runtime-client-store.js";
import { runtimeClaimFingerprint } from "../src/runtime-protocol.js";

const directories: string[] = [], hubs: RuntimeCoordinator[] = [], servers: Server[] = [], clients: RuntimeClient[] = [], sockets: WebSocket[] = [];
function home() { const dir = mkdtempSync(join(tmpdir(), "agend-pairing-2951-")); directories.push(dir); return dir; }
function hub(dir = home()) { const h = new RuntimeCoordinator(dir); hubs.push(h); return h; }
function pending(h: RuntimeCoordinator) { return h.pair({ code: h.createPairing().code, name: "Fixture", platform: "win32" }); }
function paired(h: RuntimeCoordinator) {
  const p = pending(h); h.approve(p.machineId, runtimeClaimFingerprint(p.claimSecret));
  const c = h.claim({ machineId: p.machineId, claimSecret: p.claimSecret });
  if (c.status !== "approved") throw Error("Test approval missing"); return c;
}
async function listen(h: RuntimeCoordinator) {
  const s = createServer((req, res) => { if (!h.handlePublicRequest(req, res, new URL(req.url!, "http://localhost"))) { res.writeHead(404); res.end(); } });
  s.on("upgrade", (req, sock, head) => { if (!h.handleUpgrade(req, sock, head)) sock.destroy(); }); servers.push(s);
  s.listen(0, "127.0.0.1"); await once(s, "listening"); return `http://127.0.0.1:${(s.address() as {port:number}).port}`;
}
function post(base: string, path: string, body: unknown, credential?: string, extra = {}) {
  return fetch(base + path, { method:"POST", headers:{ "Content-Type":"application/json", ...(credential ? {Authorization:`Bearer ${credential}`} : {}), ...extra }, body:JSON.stringify(body) });
}
async function profile() {
  const h = hub(), p = paired(h), base = await listen(h), store = new RuntimeClientStore(home());
  store.saveCredentials({ server:base, machineId:p.machineId, credential:p.credential, name:"Fixture" }); return {h,store,base,p};
}
const bridge = ():RuntimeBridge => ({probe:vi.fn().mockResolvedValue({home:"C:\\scratch",clis:[]}), prepareWorkspace:vi.fn(), start:vi.fn(),get:()=>null,cancel:vi.fn(),close:vi.fn(),releaseUnknown:vi.fn()});
afterEach(async()=>{
  vi.restoreAllMocks();
  for(const c of clients.splice(0))await c.stop();for(const s of sockets.splice(0))s.terminate();for(const h of hubs.splice(0))h.close();
  for(const s of servers.splice(0)){s.closeAllConnections();await new Promise<void>(r=>s.close(()=>r()));}
  for(const d of directories.splice(0))rmSync(d,{recursive:true,force:true});
});

it("binds approval to the claim-derived comparison value, not a name or a stale card",()=>{
  const h=hub(), a=pending(h), b=pending(h), fp=runtimeClaimFingerprint(a.claimSecret);
  expect(h.machine(a.machineId)?.pairingFingerprint).toBe(fp);expect(fp).toMatch(/^[A-F0-9]{4}(?:-[A-F0-9]{4}){2}$/);
  expect(()=>h.approve(a.machineId,undefined)).toThrow(/fingerprint/);expect(()=>h.approve(a.machineId,runtimeClaimFingerprint(b.claimSecret))).toThrow(/fingerprint/);
  expect(h.machine(a.machineId)?.status).toBe("pending");h.approve(a.machineId,fp);expect(h.machine(a.machineId)?.status).toBe("offline");
});
it("adds the same fingerprint to a legacy pending claim without replacing its secret",()=>{
  const dir=home(), h=hub(dir), p=pending(h);h.close();
  const file=join(dir,"runtime-machines.json"), raw=JSON.parse(readFileSync(file,"utf8"));delete raw.machines[0].machine.pairingFingerprint;writeFileSync(file,JSON.stringify(raw));
  const reopened=hub(dir);reopened.approve(p.machineId,runtimeClaimFingerprint(p.claimSecret));expect(reopened.claim({machineId:p.machineId,claimSecret:p.claimSecret}).status).toBe("approved");
});
it("bad clients behind loopback cannot exhaust valid pairings or claims; forwarded headers grant nothing",async()=>{
  const h=hub(), base=await listen(h), a=pending(h), b=pending(h);
  for(let i=0;i<35;i++)await post(base,"/runtime/v1/claim",{machineId:a.machineId,claimSecret:"bad"});
  expect((await post(base,"/runtime/v1/claim",{machineId:a.machineId,claimSecret:"bad"})).status).toBe(429);
  expect((await post(base,"/runtime/v1/pair",{code:h.createPairing().code,name:"Third",platform:"win32"})).status).toBe(201);
  for(let i=0;i<120;i++)expect((await post(base,"/runtime/v1/claim",{machineId:a.machineId,claimSecret:a.claimSecret})).status).toBe(202);
  expect((await post(base,"/runtime/v1/claim",{machineId:a.machineId,claimSecret:a.claimSecret},undefined,{"X-Forwarded-For":"203.0.113.9","Tailscale-User-Login":"other"})).status).toBe(429);
  expect((await post(base,"/runtime/v1/claim",{machineId:b.machineId,claimSecret:b.claimSecret})).status).toBe(202);
});
it("malformed JSON is bounded without consuming a valid capability's budget",async()=>{
  const h=hub(), base=await listen(h);let last=0;
  for(let i=0;i<31;i++)last=(await fetch(base+"/runtime/v1/pair",{method:"POST",body:"{"})).status;
  expect(last).toBe(429);expect((await post(base,"/runtime/v1/pair",{code:h.createPairing().code,name:"Valid",platform:"win32"})).status).toBe(201);
});
it("rotates one approved machine, immediately invalidates the old credential and closes the old connection",async()=>{
  const {h,base,p,store}=await profile(), other=paired(h), next=randomBytes(32).toString("hex");
  expect((await post(base,"/runtime/v1/rotate",{machineId:p.machineId,credential:next},other.credential)).status).toBe(400);
  expect((await post(base,"/runtime/v1/rotate",{machineId:p.machineId,credential:next},p.credential,{Origin:"http://localhost"})).status).toBe(403);
  const ws=new WebSocket(base.replace("http:","ws:")+"/runtime/v1/connect",{headers:{Authorization:`Bearer ${p.credential}`}});sockets.push(ws);await once(ws,"open");
  const welcome=once(ws,"message");ws.send(JSON.stringify({v:1,type:"hello",bootId:"fixture"}));await welcome;
  const closed=once(ws,"close"), before=JSON.parse(readFileSync(join(directories[0],"runtime-machines.json"),"utf8")).commands;
  const result=await rotateRuntimeCredentials({store});await closed;
  expect(result.credential).not.toBe(p.credential);expect(result.pendingCredential).toBeUndefined();expect(h.listMachines()).toHaveLength(2);
  expect((await post(base,"/runtime/v1/rotate",{machineId:p.machineId,credential:next},p.credential)).status).toBe(401);
  expect((await post(base,"/runtime/v1/rotate",{machineId:p.machineId,credential:result.credential},result.credential)).status).toBe(200);
  const persisted=readFileSync(join(directories[0],"runtime-machines.json"),"utf8");expect(persisted).not.toContain(result.credential);
  // alpha.2 polish: this fixture's hello brings no inventory, so the coordinator asks for one (a read-only probe the closed
  // connection then settles as failed) — rotation itself changes no command.
  const others=(rows:Array<{operation:string}>)=>rows.filter(row=>row.operation!=="probe");expect(others(JSON.parse(persisted).commands)).toEqual(others(before));
  const newSocket=new WebSocket(base.replace("http:","ws:")+"/runtime/v1/connect",{headers:{Authorization:`Bearer ${result.credential}`}});sockets.push(newSocket);await once(newSocket,"open");
});
it("lost HTTP response retains one candidate and retries it after a coordinator restart",async()=>{
  const {h,store}=await profile(), original=globalThis.fetch;let lose=true;
  vi.spyOn(globalThis,"fetch").mockImplementation(async(...args)=>{const r=await original(...args);if(lose&&r.status===200){lose=false;throw Error("lost response");}return r;});
  await expect(rotateRuntimeCredentials({store})).rejects.toThrow("lost response");const saved=store.credentials()!;expect(saved.pendingCredential).toMatch(/^[a-f0-9]{64}$/);
  h.close();const reopened=hub(directories[0]); // switch the same listener to the reopened coordinator below
  const server=servers[0];server.removeAllListeners("request");server.on("request",(req,res)=>reopened.handlePublicRequest(req,res,new URL(req.url!,"http://localhost")));
  const result=await rotateRuntimeCredentials({store:new RuntimeClientStore(store.directory)});
  expect(result.credential).toBe(saved.pendingCredential);expect(result.pendingCredential).toBeUndefined();expect(reopened.listMachines()).toHaveLength(1);
});
it("a failed local final save preserves the candidate and the original job ledger",async()=>{
  const {store}=await profile(), save=store.saveCredentials.bind(store);let count=0;
  const write=vi.spyOn(store,"saveCredentials").mockImplementation(v=>{if(++count===2)throw Error("disk full");save(v);});
  await expect(rotateRuntimeCredentials({store})).rejects.toThrow("disk full");write.mockRestore();
  const candidate=store.credentials()!.pendingCredential;expect(candidate).toBeTruthy();expect(store.list()).toEqual([]);
  expect((await rotateRuntimeCredentials({store:new RuntimeClientStore(store.directory)})).credential).toBe(candidate);
});
it("failure to save the candidate makes no network request",async()=>{
  const {store}=await profile(), fetch=vi.spyOn(globalThis,"fetch");vi.spyOn(store,"saveCredentials").mockImplementation(()=>{throw Error("write refused");});
  await expect(rotateRuntimeCredentials({store})).rejects.toThrow("write refused");expect(fetch).not.toHaveBeenCalled();expect(store.credentials()?.pendingCredential).toBeUndefined();
});
it("revoked credentials cannot rotate or resurrect a machine",async()=>{
  const {h,store,p}=await profile();h.revoke(p.machineId);
  await expect(rotateRuntimeCredentials({store})).rejects.toThrow(/not confirmed/);expect(h.machine(p.machineId)?.status).toBe("revoked");expect(store.credentials()?.pendingCredential).toBeTruthy();
});
it("start completes an interrupted rotation before opening a socket",async()=>{
  const {store}=await profile(), candidate=randomBytes(32).toString("hex");store.saveCredentials({...store.credentials()!,pendingCredential:candidate});
  const factory=vi.fn((url,credential)=>{expect(credential).toBe(candidate);expect(store.credentials()?.pendingCredential).toBeUndefined();return new WebSocket(url,{headers:{Authorization:`Bearer ${credential}`}});});
  const c=new RuntimeClient({store,bridge:bridge(),socketFactory:factory});clients.push(c);await c.start();await vi.waitFor(()=>expect(c.online()).toBe(true));expect(factory).toHaveBeenCalledTimes(1);
});
it("stop during pending rotation cannot revive the runtime or open a connection",async()=>{
  const {store}=await profile();store.saveCredentials({...store.credentials()!,pendingCredential:randomBytes(32).toString("hex")});
  const original=globalThis.fetch;let release!:()=>void, entered!:()=>void;const started=new Promise<void>(r=>entered=r), gate=new Promise<void>(r=>release=r);
  vi.spyOn(globalThis,"fetch").mockImplementation(async(...args)=>{entered();await gate;return original(...args);});
  const factory=vi.fn(), c=new RuntimeClient({store,bridge:bridge(),socketFactory:factory});clients.push(c);const start=c.start();await started;
  const rejected=expect(start).rejects.toThrow(/cancelled/), stopping=c.stop();expect(()=>store.lock("too-early")).toThrow(/Another runtime/);release();
  await Promise.all([rejected,stopping]);expect(factory).not.toHaveBeenCalled();const unlock=store.lock("test-after-cancel");unlock();
});
