/** Issuer/key-preserving certificate selection; scratch only, no native host/account. */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { provisionHubIdentity, readHubIdentity, verifyHubCertificate } from "../src/hub/tls.js";
import { prepareMemberCertificate } from "../src/hub/init/member-certificate.js";
import { ensurePrivateDirectory } from "../src/hub/private-files.js";
const homes:string[]=[];
afterEach(()=>{for(const home of homes.splice(0))rmSync(home,{recursive:true,force:true});});
async function rig(){const home=mkdtempSync(join(tmpdir(),"member-address-identity-"));homes.push(home);
 const before=await provisionHubIdentity({home,memberOrigin:"https://127.0.0.1:18443"});
 const metadata=JSON.parse(readFileSync(join(home,"hub/keys/identity.json"),"utf8")),dir=`hub/member-address/${randomUUID()}`;
 ensurePrivateDirectory(home,dir);const cert=readFileSync(join(home,"hub/keys/tls-cert.pem"),"utf8"),path=`${dir}/cert.pem`;
 writeFileSync(join(home,path),cert,{mode:0o600});return{home,before,metadata,path,cert};}
describe("#3429 member TLS selector",()=>{
 it("hostname reissue retains the private key and identity until the writer selects the new SAN",async()=>{
   const r=await rig(),metadata=readFileSync(join(r.home,"hub/keys/identity.json")),key=readFileSync(join(r.home,"hub/keys/tls-key.pem"));
   const cert=await prepareMemberCertificate(r.home+"/","https://new-member.example.test:19443");
   expect(()=>verifyHubCertificate(cert,"https://new-member.example.test:19443",r.before.spkiSha256)).not.toThrow();
   expect(()=>verifyHubCertificate(cert,"https://wrong.example.test:19443",r.before.spkiSha256)).toThrow();
   expect(readFileSync(join(r.home,"hub/keys/identity.json"))).toEqual(metadata);
   expect(readFileSync(join(r.home,"hub/keys/tls-key.pem"))).toEqual(key);
   expect(readHubIdentity({home:r.home,memberOrigin:r.metadata.memberOrigin})).toEqual(r.before);
 });
 it("a port-only move can retain the certificate byte for byte",async()=>{
   const r=await rig();expect(await prepareMemberCertificate(r.home,"https://127.0.0.1:19443")).toBe(r.cert);
 });

 it("legacy identity remains valid without changing its file bytes",async()=>{const r=await rig(),text=readFileSync(join(r.home,"hub/keys/identity.json"));expect(readHubIdentity({home:r.home,memberOrigin:r.metadata.memberOrigin})).toEqual(r.before);expect(readFileSync(join(r.home,"hub/keys/identity.json"))).toEqual(text);});
 it("a versioned certificate and new origin retain the exact issuer, Hub id and SPKI",async()=>{const r=await rig(),origin="https://127.0.0.1:19443",issuer=readFileSync(join(r.home,"hub/keys/issuer-key.pem")),key=readFileSync(join(r.home,"hub/keys/tls-key.pem"));
 writeFileSync(join(r.home,"hub/keys/identity.json"),JSON.stringify({...r.metadata,v:2,memberOrigin:origin,certificateFile:r.path}),{mode:0o600});
 expect(readHubIdentity({home:r.home,memberOrigin:origin})).toEqual(r.before);expect(()=>readHubIdentity({home:r.home,memberOrigin:r.metadata.memberOrigin})).toThrow();
 expect(readFileSync(join(r.home,"hub/keys/issuer-key.pem"))).toEqual(issuer);expect(readFileSync(join(r.home,"hub/keys/tls-key.pem"))).toEqual(key);
 });
 it.each(["hub/keys/tls-cert.pem","../outside.pem","hub/member-address/not-a-uuid/cert.pem"])("version2 never selects arbitrary path %s",async certificateFile=>{const r=await rig();writeFileSync(join(r.home,"hub/keys/identity.json"),JSON.stringify({...r.metadata,v:2,certificateFile}),{mode:0o600});expect(()=>readHubIdentity({home:r.home})).toThrow();});
});
