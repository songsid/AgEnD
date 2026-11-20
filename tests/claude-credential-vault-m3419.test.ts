import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, readdirSync, lstatSync, symlinkSync, unlinkSync, renameSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { ClaudeCredentialVault } from "../src/claude-credential-vault.js";
const dirs: string[] = [], vaults: ClaudeCredentialVault[] = [];
const actor = { adapterId: "test-adapter", userId: "test-admin" };
const secret = "synthetic-" + "x".repeat(48), other = "synthetic-" + "y".repeat(48);
function rig() { const home = mkdtempSync(join(tmpdir(), "claude-vault-")); dirs.push(home); const v = new ClaudeCredentialVault(home); vaults.push(v); return {home,v,db:join(home,"credential-vault/claude.sqlite"),key:join(home,"credential-keys/claude.key")}; }
afterEach(() => { for (const v of vaults.splice(0)) { try { v.close(); } catch {} } for (const d of dirs.splice(0)) rmSync(d,{recursive:true,force:true}); });
describe("managed Claude vault", () => {
 it("encrypts saved values, metadata/audit contain no value, restart decrypts only a bound id/revision", () => {
  const r=rig(), m=r.v.write("spare",0,{kind:"api-key",value:secret},actor);
  expect(m).toMatchObject({profile:"spare",revision:1,kind:"api-key",state:"saved-unverified"});
  expect(readFileSync(r.db).includes(Buffer.from(secret))).toBe(false);
  expect(JSON.stringify([m,r.v.history()])).not.toContain(secret);
  const next=new ClaudeCredentialVault(r.home); vaults.push(next);
  const raw=next.credential("spare",m.id,1);expect(raw.value.toString()).toBe(secret);raw.value.fill(0);
  expect(()=>next.credential("other",m.id,1)).toThrow("conflict");
  expect(()=>next.credential("spare",m.id,2)).toThrow("conflict");
  expect(lstatSync(r.db).mode&0o777).toBe(0o600);expect(lstatSync(r.key).mode&0o777).toBe(0o600);
  expect(lstatSync(join(r.home,"credential-vault")).mode&0o777).toBe(0o700);
 });
 it("CAS serializes two connections and deletion keeps the id and revision to prevent ABA", () => {
  const r=rig(), b=new ClaudeCredentialVault(r.home);vaults.push(b);
  const a=r.v.write(null,0,{kind:"setup-token",value:secret},actor);
  expect(()=>b.write(null,0,{kind:"api-key",value:other},actor)).toThrow("conflict");
  const removed=b.write(null,1,null,actor);expect(removed).toMatchObject({id:a.id,revision:2,kind:null,state:"not-connected"});
  expect(()=>r.v.write(null,0,{kind:"api-key",value:other},actor)).toThrow("conflict");
  const c=r.v.write(null,2,{kind:"api-key",value:other},actor);expect(c.id).toBe(a.id);expect(c.revision).toBe(3);
  expect(r.v.history().map((x:any)=>x.action)).toEqual(["set","remove","set"]);
 });
 it("a failing audit insertion rolls back ciphertext and revision together", () => {
  const r=rig();r.v.write(null,0,{kind:"api-key",value:secret},actor);
  const db=new Database(r.db);db.exec("CREATE TRIGGER refuse_audit BEFORE INSERT ON credential_audit BEGIN SELECT RAISE(ABORT,'test refusal'); END");db.close();
  expect(()=>r.v.write(null,1,{kind:"setup-token",value:other},actor)).toThrow();
  expect(r.v.metadata(null)?.revision).toBe(1);expect(r.v.history()).toHaveLength(1);
 });
 it("AAD binds profile/kind/revision/id; corruption or wrong/missing key never falls back", () => {
  const r=rig(),m=r.v.write("spare",0,{kind:"api-key",value:secret},actor);
  const db=new Database(r.db);
  for(const [field,next] of [["kind","setup-token"],["id","other-id"],["revision",2],["profile","other-profile"]] as const){
   const old=(db.prepare("SELECT * FROM credentials").get() as any)[field];
   db.prepare(`UPDATE credentials SET ${field}=?`).run(next);
   expect(()=>r.v.credential(field==="profile"?String(next):"spare",field==="id"?String(next):m.id,field==="revision"?Number(next):1)).toThrow("unavailable");
   db.prepare(`UPDATE credentials SET ${field}=?`).run(old);
  }
  db.close();
  expect(()=>new ClaudeCredentialVault(r.home,{key:()=>Buffer.alloc(32,9)})).toThrow("unavailable");
  unlinkSync(r.key);expect(()=>new ClaudeCredentialVault(r.home)).toThrow("unavailable");
  expect(()=>readFileSync(r.key)).toThrow();
 });
 it("refuses linked/loose key, vault directory and replacement database", () => {
  const r=rig();chmodSync(r.key,0o644);expect(()=>new ClaudeCredentialVault(r.home)).toThrow("unavailable");chmodSync(r.key,0o600);
  const saved=r.key+'.saved';renameSync(r.key,saved);symlinkSync(saved,r.key);expect(()=>new ClaudeCredentialVault(r.home)).toThrow("unavailable");unlinkSync(r.key);renameSync(saved,r.key);
  const db=r.db+'.old';renameSync(r.db,db);writeFileSync(r.db,readFileSync(db),{mode:0o600});expect(()=>r.v.metadata(null)).toThrow("unavailable");
  const home=mkdtempSync(join(tmpdir(),"claude-linked-"));dirs.push(home);symlinkSync(join(r.home,"credential-vault"),join(home,"credential-vault"));expect(()=>new ClaudeCredentialVault(home)).toThrow("unavailable");
 });
 it("rejects unsafe values and profile names without serializing them, and bounds audit retention", () => {
  const r=rig();
  for(const value of ["short",secret+'\n',secret+'\0',"x".repeat(17000)]) expect(()=>r.v.write(null,0,{kind:"api-key",value},actor)).toThrow("invalid");
  expect(()=>r.v.write("../escape",0,{kind:"api-key",value:secret},actor)).toThrow("invalid");
  expect(r.v.metadata(null)).toBeNull();expect(r.v.history()).toEqual([]);
  expect(readdirSync(r.home).sort()).toEqual(["credential-keys","credential-vault"]);
  (r.v as any).db.transaction(()=>{ for(let i=0;i<1003;i++) r.v.audit(actor,null,"set-or-replace",null,null,"invalid"); })();
  const db=new Database(r.db);expect((db.prepare("SELECT count(*) AS n FROM credential_audit").get() as any).n).toBe(1000);db.close();
 });
});
it("subscription selection is explicit, audited and revision-bound, and never resurrects a removed secret",()=>{
 const r=rig(),first=r.v.write(null,0,{kind:"api-key",value:secret},actor);
 const removed=r.v.write(null,1,null,actor);expect(removed.source).toBe("managed");
 const selected=r.v.write(null,2,"subscription",actor);
 expect(selected).toMatchObject({id:first.id,revision:3,kind:null,source:"subscription"});
 expect(()=>r.v.credential(null,first.id,1)).toThrow("conflict");
 expect(()=>r.v.write(null,2,"subscription",actor)).toThrow("conflict");
 const next=r.v.write(null,3,{kind:"setup-token",value:other},actor);
 expect(next).toMatchObject({id:first.id,revision:4,source:"managed"});
 expect(r.v.history().map((row:any)=>row.action)).toEqual(["set","select-subscription","remove","set"]);
});
it("the additive source migration preserves old tombstones as managed",()=>{
 const r=rig();r.v.write(null,0,null,actor);r.v.close();vaults.splice(vaults.indexOf(r.v),1);
 const db=new Database(r.db);db.exec("ALTER TABLE credentials DROP COLUMN source");db.close();
 const migrated=new ClaudeCredentialVault(r.home);vaults.push(migrated);
 expect(migrated.metadata(null)).toMatchObject({revision:1,kind:null,source:"managed"});
});
