/** Stop/Run is a service pause. Real sealed Hub HTTPS + production AD over an owned LDAPS peer. */
import { afterEach, expect, it, vi } from "vitest";
const dc=vi.hoisted(()=>({port:0}));
vi.mock('node:tls',async original=>{const real=await original<typeof import('node:tls')>();return{...real,connect:(o:import('node:tls').ConnectionOptions)=>real.connect({...o,...(o.host==='127.0.0.1'&&o.port===636?{port:dc.port}:{})})};});
import { companyJoinRig } from './support/hub-company-join-rig.js';
import { HubRuntime } from '../src/hub/runtime.js';
import { createHubDirectory } from '../src/hub/directory/index.js';
let rig:Awaited<ReturnType<typeof companyJoinRig>>|undefined,runtime:HubRuntime|undefined;
afterEach(async()=>{await runtime?.close();runtime=undefined;await rig?.close();rig=undefined;});
it('Stop closes the listener; Run retains only still-valid sessions, never explicit sign-outs or expired ones',async()=>{
 const r=rig=await companyJoinRig(port=>{dc.port=port;});
 const valid=await r.signIn('alice'),ended=await r.signIn('carol'),expired=await r.signIn('dan');
 expect((await r.call(ended,'DELETE','/hub/v1/session')).status).toBe(200);
 // Exact expiry row selected by its cookie hash, independent of PersonKey serialization.
 const {createHash}=await import('node:crypto');const expiredToken=expired.cookie.slice(expired.cookie.indexOf('=')+1);
 r.db.prepare('UPDATE hub_sessions SET expires_at=1 WHERE token_hash=?').run(createHash('sha256').update(expiredToken).digest('hex'));
 await r.stopService();
 runtime=new HubRuntime({home:r.home,log(){},createDirectory:(cfg,secrets)=>createHubDirectory({...cfg,caPem:r.dcCerts.ca},secrets)});
 await runtime.apply({hub:r.config});expect(runtime.currentHolds()).toEqual([]);
 expect((await r.call(valid,'GET','/hub/v1/session')).body.signedIn).toBe(true);
 await runtime.apply({hub:{...r.config,enabled:false}});
 await expect(r.call(valid,'GET','/hub/v1/session')).rejects.toMatchObject({code:'ECONNREFUSED'});
 await runtime.apply({hub:r.config});expect(runtime.currentHolds()).toEqual([]);
 expect((await r.call(valid,'GET','/hub/v1/session')).body.signedIn).toBe(true);
 expect((await r.call(ended,'GET','/hub/v1/session')).body.signedIn).toBe(false);
 expect((await r.call(expired,'GET','/hub/v1/session')).body.signedIn).toBe(false);
},20000);
