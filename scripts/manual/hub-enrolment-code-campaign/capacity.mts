/** Prepared combined campaign: real Fleet Settings + compiled join clients, synthetic LDAPS. Never launched by import on the host. */
import { request as httpsRequest } from 'node:https';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, randomBytes, generateKeyPairSync, createPublicKey, createHash } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
if (process.env.SAFE_RUN !== '1' || process.env.AGEND_OWNED_CONTAINER !== 'hub-enrolment-code-campaign' || !existsSync('/.dockerenv')) throw Error('Owned SAFE_RUN container required');
const out=process.env.OUT!, root=mkdtempSync(join(tmpdir(),'ridge-b1-')); mkdirSync(out,{recursive:true});
process.env.AGEND_HOME=join(root,'environment');mkdirSync(process.env.AGEND_HOME,{mode:0o700});
const receipt:any={source:process.env.CAMPAIGN_SHA,checks:[],waves:[],screenshots:[],boundary:'Owned network-none source build. Five independent production Fleet web/settings/join/member services per mass wave, no Agent lifecycle or backend CLI. Remaining clients use shipped compiled join/member code and explicit harness-side durable profiles. Synthetic LDAP; owned HTTPS proxies; deliberate eligibility-delay control for real admission backpressure. Not packaged/systemd/native/pilot/real AD.'};
const check=(name:string,pass:boolean)=>{receipt.checks.push({name,pass});console.log(JSON.stringify({check:name,pass}));if(!pass)throw Error(name);};
const wait=async(fn:()=>boolean,ms=30000)=>{const end=Date.now()+ms;while(!fn()&&Date.now()<end)await new Promise(r=>setTimeout(r,40));if(!fn())throw Error('Owned fixture deadline');};
const tls=createRequire(import.meta.url)('node:tls'), original=tls.connect;let dc=0;
tls.connect=(options:any,...args:any[])=>original({...options,...(options.host==='127.0.0.1'&&options.port===636?{port:dc}:{}),...(options.host==='hub.example.test'?{host:'127.0.0.1'}:{})},...args);syncBuiltinESMExports();
const {campaignUi}=await import('./fleets.mts');
const {CompanyJoinClient}=await import('/tmp/b1-dist/hub/join/client.js');
const {HubMemberClient}=await import('/tmp/b1-dist/hub/client.js');
const {HubMemberClient:LegacyHubMemberClient}=await import('/legacy/src/hub/client.ts');
const {HubMemberProfileStore}=await import('/tmp/b1-dist/hub/profile.js');
const {issuerKeyId}=await import('/tmp/b1-dist/hub/identity.js');
const {pkceChallenge}=await import('/tmp/b1-dist/hub/join/protocol.js');
const {createJoinApprovalQueue}=await import('/tmp/b1-dist/ui/hub-join-queue.js');
const {createLocalJoin,saveLocalJoin}=await import('/tmp/b1-dist/hub/join/local-journal.js');
const {syncJoinPrivate}=await import('/tmp/b1-dist/hub/join/private.js');
const {companyJoinRig}=await import('../../../tests/support/hub-company-join-rig.js');
const {chromium}=await import('playwright-core');
let rig:any,browser:any,ui:any;const clients:any[]=[],online=new Set<string>();
const group='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
try {
 rig=await companyJoinRig((port:number)=>dc=port);
 rig.call=(actor:any,method:string,path:string,body?:any,extra:any={})=>new Promise((resolve,reject)=>{
  const bytes=body===undefined?undefined:typeof body==='string'?body:JSON.stringify(body),machine=/^\/hub\/v1\/join\/(challenge|push|status|redeem|ack|cancel|tombstone)$/.test(path);
  const endpoint=new URL(machine?rig.memberOrigin:rig.webOrigin),headers:any={Host:new URL(rig.webOrigin).host,Origin:rig.webOrigin,...(actor?{Cookie:actor.cookie,'X-AgEnD-Hub-CSRF':actor.csrf}:{}),...(bytes===undefined?{}:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(bytes)}),...extra};
  for(const key of Object.keys(headers))if(headers[key]===undefined)delete headers[key];
  const req=httpsRequest({host:'127.0.0.1',port:endpoint.port,servername:endpoint.hostname,ca:readFileSync(machine?join(rig.home,'hub/keys/tls-cert.pem'):rig.certs.caCert),method,path,headers,agent:false},res=>{
   let text='';res.setEncoding('utf8');res.on('data',c=>text+=c);res.on('error',reject);res.on('end',()=>{let body:any;try{body=JSON.parse(text);}catch{body=text;}resolve({status:res.statusCode,body,text,cookie:(res.headers['set-cookie']?.[0]??'').split(';')[0],headers:res.headers});});
  });req.setTimeout(20000,()=>req.destroy(Error('Owned campaign HTTP deadline')));req.on('error',reject);req.end(bytes);
 });

 const admin=await rig.signIn('alice');await rig.enable(admin,1);
 check('company join enabled',(await rig.call(admin,'PUT','/hub/v1/admin/company-join',{enabled:true,expectedRevision:1})).status===200);
 const client=new CompanyJoinClient({ca:readFileSync(rig.certs.caCert),lookup:(_h:string,o:any,d:any)=>o.all?d(null,[{address:'127.0.0.1',family:4}]):d(null,'127.0.0.1',4)});
 const metadata=await client.discover(rig.webOrigin,()=>true);check('built strict discovery advertises code',metadata.features.includes('enrolment-code-v1'));
 browser=await chromium.launch({args:['--no-sandbox','--no-proxy-server','--host-resolver-rules=MAP *.example.test 127.0.0.1']});
 ui=campaignUi(rig,browser,receipt,check,online);
 await ui.adminShots();
 const create=async(maxUses:number)=>{const r=await rig.call(admin,'POST','/hub/v1/admin/enrolment-codes',{expires:'today',maxUses,perPersonFleets:1,scope:{kind:'directory'}});check('admin creates '+maxUses+'-use code',r.status===201);return r.body;};
 const secrets:string[]=[];
 let signins=0;const signinWaiters:Array<()=>void>=[];
 const enterSignin=async()=>{if(signins<3){signins++;return;}await new Promise<void>(resolve=>signinWaiters.push(resolve));};
 const leaveSignin=()=>{const next=signinWaiters.shift();if(next)next();else signins--;};
 async function attempt(code:string|null,login:string,visible:any=null,beforeSignIn=async()=>{},onQueued=()=>{},legacy=false) {
  if(visible)return ui.joinFleet(visible,code,login,beforeSignIn,onQueued);
  const started=Date.now(), key=generateKeyPairSync('ed25519'), verifier=randomBytes(32).toString('base64url'), state=randomBytes(32).toString('hex');
  const binding={hub:metadata.hub,requestId:randomUUID(),operationId:randomUUID(),fleetId:randomUUID(),publicKey:key.publicKey.export({type:'spki',format:'pem'}).toString(),fleetOrigin:'https://'+login+'.example.test:43210',verifierS256:pkceChallenge(verifier)};
  const command=(purpose:any,payload:any={})=>client.command(binding,purpose,payload,key.privateKey,()=>true);
  await command('push',{label:'Owned '+login,stateHash:createHash('sha256').update(state).digest('hex'),invitation:null,...(code?{code}:{})});
  const open=await rig.call(null,'POST','/hub/join/open',new URLSearchParams({requestId:binding.requestId,state}).toString(),{'Content-Type':'application/x-www-form-urlencoded',Origin:binding.fleetOrigin});
  check('Origin-bound browser handoff '+login,open.status===303);
  let signed:any;await enterSignin();try{signed=await rig.signIn(login);signed.cookie+='; '+open.cookie;}finally{leaveSignin();}
  const approval=createJoinApprovalQueue({requestId:binding.requestId,csrf:signed.csrf,deadline:started+600000,current:()=>true,
   approve:async()=>{const r=await rig.call(signed,'POST','/hub/v1/join/approve',{requestId:binding.requestId});return{ok:r.status===200,code:r.body.code??r.body.error,reason:r.body.reason};},
   onChange:(e:any)=>{if(e.phase==='queued')receipt.clientQueueRetries=(receipt.clientQueueRetries??0)+1;}});
  const approved=await approval.run();approval.cancel();if(!approved.ok)return{started,issued:false,binding};
  let issued:any;
  for(let n=0;n<9;n++){try{issued=await command('redeem',{verifier});break;}catch(error:any){if(error.code!=='backpressure'||n===8)return{started,issued:false,binding};await new Promise(r=>setTimeout(r,2000+Math.random()*4000));}}
  if(!issued?.credential)return{started,issued:false,binding};
  const home=join(root,binding.fleetId);mkdirSync(home,{mode:0o700});
  new HubMemberProfileStore(home,metadata.hub.hubId).saveProfile({v:1,hub:issued.hub,owner:issued.owner,fleetId:binding.fleetId,certificatePem:issued.certificatePem,credential:issued.credential,issuerKeyId:issuerKeyId(createPublicKey(issued.hub.issuerPublicKey))},null,()=>true);
  const profileDigest=new HubMemberProfileStore(home,metadata.hub.hubId).profileDigest(),journalCommitId=randomUUID();syncJoinPrivate(home,'hub-member/'+metadata.hub.hubId+'/pairing.json');
  const journal={v:1 as const,operationId:binding.operationId,handoffId:randomUUID(),binding,privateKey:key.privateKey.export({type:'pkcs8',format:'pem'}).toString(),verifier,browserState:state,certificatePem:issued.certificatePem,sessionId:randomBytes(32).toString('hex'),authorityEpoch:1,hostConfirmed:true,snapshot:{membership:true,binding:null},createdAt:started,deadline:started+600000,stage:'durable' as const,reason:null,issued:true,outcomeKnown:true,issuedHash:createHash('sha256').update(issued.credential).digest('hex'),profileDigest,replaceProfile:null,intendedBinding:null,enableIntent:false,journalCommitId,remoteState:'issued'};
  createLocalJoin(home,journal,()=>true);
  await command('ack',{verifier,credentialHash:journal.issuedHash,profileDigest,journalCommitId});saveLocalJoin(home,{...journal,stage:'active'},()=>true);
  const member=new (legacy?LegacyHubMemberClient:HubMemberClient)({home,hubId:metadata.hub.hubId,memberOrigin:metadata.hub.memberOrigin,current:()=>true,
   reconcile:async()=>{online.add(binding.fleetId);},receive:async()=>{},hold:()=>{}});clients.push(member);await member.start().catch(()=>{});await wait(()=>online.has(binding.fleetId),60000);
  return{started,issued:true,binding,connected:Date.now(),home,member};
 }
 function people(prefix:string,n:number,groups:string[]=[]){return Array.from({length:n},(_,i)=>{const login=prefix+i;rig.people.push({id:randomUUID(),login,dn:'CN='+login+',DC=example,DC=test',password:'Dummy-'+login+'-only',groups});return login;});}
 async function wave(n:number,prefix:string,withGroups=false){
  const visible=await Promise.all(Array.from({length:5},(_,i)=>ui.prepareFleet(i,prefix)));
  const code=await create(n);secrets.push(code.code.replace('-',''));const persons=people(prefix,n),start=Date.now();
  const groupPeople=withGroups?people(prefix+'group',3,[group]):[];
  // Deliberately hold actual eligibility promises AFTER the shared read pool admits them. No forged HTTP response/permit.
  const original=rig.directory.checkEligibility.bind(rig.directory);let held=0,released=n!==50,release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=()=>{released=true;resolve();};});
  rig.directory.checkEligibility=async(...args:any[])=>{if(!released){held++;await gate;}return original(...args);};
  const deadline=setTimeout(release,12000);const beforeSignIn=async()=>{if(n===50)await wait(()=>held>=32||released,11000);};
  const queueBefore=receipt.queueTextObserved??0;
  let result:any[];
  try{result=await Promise.all([...persons.map((p,i)=>attempt(code.code,p,i<5?visible[i]:null,beforeSignIn,release)),...groupPeople.map(p=>attempt(null,p))]);}
  finally{release();clearTimeout(deadline);rig.directory.checkEligibility=original;}
  const uses=rig.db.prepare('SELECT uses FROM hub_enrolment_codes WHERE id=?').get(code.id).uses;
  check(prefix+' all issued and pinned member links online',result.every(r=>r.issued));check(prefix+' uses counted once',uses===n);
  const pushed=result.map(r=>rig.deps.companyJoin.records.get(r.binding.requestId).createdAt);
  const span=Math.max(...pushed)-Math.min(...pushed),elapsed=Date.now()-start;
  check(prefix+' starts inside 60 seconds',span<60000);check(prefix+' connected within five minutes',elapsed<300000);
  if(n===50)check(prefix+' queue text appeared on a real Hub page',(receipt.queueTextObserved??0)>queueBefore);
  const list=await rig.call(admin,'GET','/hub/v1/admin/enrolment-codes');check(prefix+' recent labels and owners',list.body.codes.find((c:any)=>c.id===code.id).recent.length===n);
  const view=await ui.adminPage();try{for(const f of visible)check(prefix+' labelled admin row '+f.label,await view.page.locator('.hub-fleet-list').getByText(f.label,{exact:true}).count()===1);await ui.shot(view.page,prefix+'-labelled-fleets');}finally{await view.ctx.close();}
  const extra=people(prefix+'extra',1)[0];check(prefix+' next push refuses after exhaustion',await attempt(code.code,extra).then(()=>false,(e:any)=>e.code==='denied'));
  receipt.waves.push({n,groups:groupPeople.length,startSpanMs:span,elapsedMs:elapsed,uses,everConnected:online.size,controlledHeldEligibility:held,hubAndFleetsRss:process.memoryUsage().rss,
   databaseBytes:statSync(join(rig.home,'hub/hub.sqlite')).size,walBytes:existsSync(join(rig.home,'hub/hub.sqlite-wal'))?statSync(join(rig.home,'hub/hub.sqlite-wal')).size:0});
  await ui.closeVisible();
 }
 await wave(20,'small');await wave(50,'mass');await wave(50,'withgroups',true);
 await ui.cachedShots();
 const compat=await create(1);secrets.push(compat.code.replace('-',''));const compatPerson=people('compat',1)[0];
 const retained=await attempt(compat.code,compatPerson,null,async()=>{},()=>{},true);check('B-L9 old v2-only member link connected',retained.issued);
 const target=()=>rig.db.prepare("SELECT state FROM hub_pairing_notice_targets WHERE kind='fleet' AND target=?").get(retained.binding.fleetId)?.state;
 check('B-L9 code notice remains queued for actual old member',target()==='queued');
 await retained.member.close();online.delete(retained.binding.fleetId);
 const upgraded=new HubMemberClient({home:retained.home,hubId:metadata.hub.hubId,memberOrigin:metadata.hub.memberOrigin,current:()=>true,reconcile:async()=>{online.add(retained.binding.fleetId);},receive:async()=>{},hold:()=>{}});
 clients.push(upgraded);await upgraded.start();await wait(()=>target()==='delivered',30000);check('B-L9 code notice delivered after actual member upgrade',online.has(retained.binding.fleetId));

 const revoke=await create(50);secrets.push(revoke.code.replace('-',''));const names=people('revoke',50);
 const revokeStarts:number[]=[];const launchRevoke=(p:string)=>{revokeStarts.push(Date.now());return attempt(revoke.code,p);};
 const first=await Promise.all(names.slice(0,25).map(launchRevoke));check('revoke first 25 issued',first.every(x=>x.issued));
 check('admin revokes mid-wave',(await rig.call(admin,'POST','/hub/v1/admin/enrolment-codes/'+revoke.id+'/revoke',{})).status===200);
 const rest=await Promise.all(names.slice(25).map(p=>launchRevoke(p).then(()=>false,(e:any)=>e.code==='denied')));check('nothing issues after revocation',rest.every(Boolean));
 check('revoke wave starts within 60 seconds',Math.max(...revokeStarts)-Math.min(...revokeStarts)<60000);
 receipt.waves.push({kind:'revoke-at-25',started:Math.min(...revokeStarts),startSpanMs:Math.max(...revokeStarts)-Math.min(...revokeStarts),uses:25,hubAndFleetsRss:process.memoryUsage().rss,databaseBytes:statSync(join(rig.home,'hub/hub.sqlite')).size});
 check('revoked counter stops at 25',rig.db.prepare('SELECT uses FROM hub_enrolment_codes WHERE id=?').get(revoke.id).uses===25);
 check('issued fleets stay active after code revocation',rig.deps.store.read().fleets.filter((f:any)=>f.status==='active').length===149);
 check('no join expired',rig.db.prepare("SELECT count(*) n FROM hub_company_join_requests WHERE json_extract(body,'$.reason')='expired'").get().n===0);
 const scan=(directory:string):boolean=>readdirSync(directory,{withFileTypes:true}).every(entry=>entry.isDirectory()?scan(join(directory,entry.name)):!secrets.some(s=>readFileSync(join(directory,entry.name)).includes(Buffer.from(s))));
 check('no plain code anywhere in Hub home',scan(rig.home));check('audit hash chain',rig.deps.audit.verifyChain().ok===true);receipt.ready=true;
}catch(error){receipt.error=String(error);console.error(error);process.exitCode=1;}
finally{
 const failures:string[]=[];const clean=async(name:string,work:()=>any)=>{try{await work();}catch{failures.push(name);}};
 for(const c of clients.reverse())await clean('member',()=>c.close());await clean('fleets',()=>ui?.closeVisible());await clean('browser',()=>browser?.close());await clean('Hub',()=>rig?.close());
 tls.connect=original;syncBuiltinESMExports();rmSync(root,{recursive:true,force:true});receipt.cleaned=failures.length===0;if(failures.length){receipt.cleanupFailures=failures;receipt.ready=false;}
 const files=["src/hub/audit/index.ts", "src/hub/catalog.ts", "src/hub/client.ts", "src/hub/compose/member.ts", "src/hub/compose/server.ts", "src/hub/enrolment-code.ts", "src/hub/group-policy/admin-impact.ts", "src/hub/group-policy/admin-inventory.ts", "src/hub/group-policy/authorization.ts", "src/hub/group-policy/impact-inventory.ts", "src/hub/group-policy/resources.ts", "src/hub/group-policy/store.ts", "src/hub/http/compose.ts", "src/hub/join/receipt.ts", "src/hub/join/service.ts", "src/hub/join/store.ts", "src/hub/member/pairing-notices.ts", "src/hub/pairing-notices.ts", "src/hub/pairing.ts", "src/hub/protocol.ts", "src/hub/server.ts", "src/hub/types.ts", "src/settings-api.ts"];
 files.push('src/fleet-manager.ts','src/ui/hub-join-steps.js','src/ui/hub-enrolment-code.js','src/ui/hub-enrolment-code-strings.js','src/ui/hub-join-approval.js','src/ui/hub-join-queue.js','src/ui/hub-client.js','src/ui/hub-company-join.js','src/ui/settings-hub.js','src/ui/settings-hub-company-join.js');
 receipt.production=files.map(path=>({path,sha256:createHash('sha256').update(readFileSync('/work/'+path)).digest('hex')}));
 receipt.images=receipt.screenshots.map((path:string)=>({path,sha256:createHash('sha256').update(readFileSync(join(out,path))).digest('hex')}));writeFileSync(join(out,'receipt-runtime.json'),JSON.stringify(receipt,null,2));
}
console.log(JSON.stringify({ready:receipt.ready===true,checks:receipt.checks.length,error:receipt.error}));process.exit(receipt.ready?0:1);
