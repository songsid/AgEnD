/** Built Fleet join/member clients, production Hub, verified synthetic LDAPS, and browser handoff. No backend CLI. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, randomBytes, generateKeyPairSync, createPublicKey, createHash } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
if (process.env.SAFE_RUN !== '1' || process.env.AGEND_OWNED_CONTAINER !== 'hub-enrolment-code-b1' || !existsSync('/.dockerenv')) throw Error('Owned SAFE_RUN container required');
const out=process.env.OUT!, root=mkdtempSync(join(tmpdir(),'ridge-b1-')); mkdirSync(out,{recursive:true});
process.env.AGEND_HOME=join(root,'environment');mkdirSync(process.env.AGEND_HOME,{mode:0o700});
const receipt:any={checks:[],waves:[],screenshots:[],boundary:'Read-only network-none owned container. Production source Hub/SQLite/verified fake LDAPS. Built dist/hub/join/client.js and dist/hub/client.js, real pinned WSS. Five Chromium AD handoffs; harness persists member profiles directly after real redemption. Not five full Fleet services or Settings UI, not packaged/systemd; B-L11/12 UI and queue text remain B2/U2 acceptance.'};
const check=(name:string,pass:boolean)=>{receipt.checks.push({name,pass});console.log(JSON.stringify({check:name,pass}));if(!pass)throw Error(name);};
const wait=async(fn:()=>boolean,ms=30000)=>{const end=Date.now()+ms;while(!fn()&&Date.now()<end)await new Promise(r=>setTimeout(r,40));if(!fn())throw Error('Owned fixture deadline');};
const tls=createRequire(import.meta.url)('node:tls'), original=tls.connect;let dc=0;
tls.connect=(options:any,...args:any[])=>original({...options,...(options.host==='127.0.0.1'&&options.port===636?{port:dc}:{}),...(options.host==='hub.example.test'?{host:'127.0.0.1'}:{})},...args);syncBuiltinESMExports();
const {CompanyJoinClient}=await import('/tmp/b1-dist/hub/join/client.js');
const {HubMemberClient}=await import('/tmp/b1-dist/hub/client.js');
const {HubMemberProfileStore}=await import('/tmp/b1-dist/hub/profile.js');
const {issuerKeyId}=await import('/tmp/b1-dist/hub/identity.js');
const {pkceChallenge}=await import('/tmp/b1-dist/hub/join/protocol.js');
const {createLocalJoin,saveLocalJoin}=await import('/tmp/b1-dist/hub/join/local-journal.js');
const {syncJoinPrivate}=await import('/tmp/b1-dist/hub/join/private.js');
const {companyJoinRig}=await import('../../../tests/support/hub-company-join-rig.js');
const {chromium}=await import('playwright-core');
let rig:any,browser:any;const clients:any[]=[],online=new Set<string>();
const group='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
try {
 rig=await companyJoinRig((port:number)=>dc=port);
 const admin=await rig.signIn('alice');await rig.enable(admin,1);
 check('company join enabled',(await rig.call(admin,'PUT','/hub/v1/admin/company-join',{enabled:true,expectedRevision:1})).status===200);
 const client=new CompanyJoinClient({ca:readFileSync(rig.certs.caCert),lookup:(_h:string,o:any,d:any)=>o.all?d(null,[{address:'127.0.0.1',family:4}]):d(null,'127.0.0.1',4)});
 const metadata=await client.discover(rig.webOrigin,()=>true);check('built strict discovery advertises code',metadata.features.includes('enrolment-code-v1'));
 browser=await chromium.launch({args:['--no-sandbox','--no-proxy-server','--host-resolver-rules=MAP hub.example.test 127.0.0.1']});
 const create=async(maxUses:number)=>{const r=await rig.call(admin,'POST','/hub/v1/admin/enrolment-codes',{expires:'today',maxUses,perPersonFleets:1,scope:{kind:'directory'}});check('admin creates '+maxUses+'-use code',r.status===201);return r.body;};
 const secrets:string[]=[];
 let signins=0;const signinWaiters:Array<()=>void>=[];
 const enterSignin=async()=>{if(signins<4){signins++;return;}await new Promise<void>(resolve=>signinWaiters.push(resolve));};
 const leaveSignin=()=>{const next=signinWaiters.shift();if(next)next();else signins--;};
 async function attempt(code:string|null,login:string,visible=false) {
  const started=Date.now(), key=generateKeyPairSync('ed25519'), verifier=randomBytes(32).toString('base64url'), state=randomBytes(32).toString('hex');
  const binding={hub:metadata.hub,requestId:randomUUID(),operationId:randomUUID(),fleetId:randomUUID(),publicKey:key.publicKey.export({type:'spki',format:'pem'}).toString(),fleetOrigin:'https://'+login+'.example.test:43210',verifierS256:pkceChallenge(verifier)};
  const command=(purpose:any,payload:any={})=>client.command(binding,purpose,payload,key.privateKey,()=>true);
  await command('push',{label:'Owned '+login,stateHash:createHash('sha256').update(state).digest('hex'),invitation:null,...(code?{code}:{})});
  const open=await rig.call(null,'POST','/hub/join/open',new URLSearchParams({requestId:binding.requestId,state}).toString(),{'Content-Type':'application/x-www-form-urlencoded',Origin:binding.fleetOrigin});
  check('Origin-bound browser handoff '+login,open.status===303);
  let signed:any;await enterSignin();try{
  if(visible){
   const language=login.endsWith('1')?'zh-TW':'en-US',context=await browser.newContext({ignoreHTTPSErrors:true,locale:language,viewport:{width:login.endsWith('1')?390:1366,height:900}});
   const [name,value]=open.cookie.split('=');await context.addCookies([{name,value,url:rig.webOrigin}]);await context.addInitScript((lang:string)=>localStorage.setItem('agend_lang',lang),language);
   const page=await context.newPage();await page.goto(rig.webOrigin+'/ui/hub?join='+binding.requestId);await page.locator('#hubLogin').fill(login);await page.locator('#hubPassword').fill('Dummy-'+login+'-only');
   await page.getByRole('button',{name:/登入並連接 Fleet|Sign in and connect Fleet/,exact:true}).click();
   await wait(()=>rig.deps.companyJoin.records.get(binding.requestId).stage==='identity-approved');
   await page.getByText('Owned '+login,{exact:false}).first().waitFor();
   if(!(await page.locator('body').innerText()).includes('Owned '+login))throw Error('Wrong handoff label before capture');
   const shot=login+'.'+language+'.png';await page.screenshot({path:join(out,shot)});receipt.screenshots.push(shot);await context.close();
  }else{signed=await rig.signIn(login);signed.cookie+='; '+open.cookie;}
  }finally{leaveSignin();}
  const approve=async()=>{
   for(let n=0;n<9;n++){
    const r=await rig.call(signed,'POST','/hub/v1/join/approve',{requestId:binding.requestId});
    if(r.status===200)return true;
    if(r.body.code!=='backpressure'||n===8)return false;
    receipt.queueRetries=(receipt.queueRetries??0)+1;await new Promise(r=>setTimeout(r,2000+Math.random()*4000));
   }return false;
  };
  if(!visible&&!await approve())return{started,issued:false,binding};
  let issued:any;
  for(let n=0;n<9;n++){try{issued=await command('redeem',{verifier});break;}catch(error:any){if(error.code!=='backpressure'||n===8)return{started,issued:false,binding};await new Promise(r=>setTimeout(r,2000+Math.random()*4000));}}
  if(!issued?.credential)return{started,issued:false,binding};
  const home=join(root,binding.fleetId);mkdirSync(home,{mode:0o700});
  new HubMemberProfileStore(home,metadata.hub.hubId).saveProfile({v:1,hub:issued.hub,owner:issued.owner,fleetId:binding.fleetId,certificatePem:issued.certificatePem,credential:issued.credential,issuerKeyId:issuerKeyId(createPublicKey(issued.hub.issuerPublicKey))},null,()=>true);
  const profileDigest=new HubMemberProfileStore(home,metadata.hub.hubId).profileDigest(),journalCommitId=randomUUID();syncJoinPrivate(home,'hub-member/'+metadata.hub.hubId+'/pairing.json');
  const journal={v:1 as const,operationId:binding.operationId,handoffId:randomUUID(),binding,privateKey:key.privateKey.export({type:'pkcs8',format:'pem'}).toString(),verifier,browserState:state,certificatePem:issued.certificatePem,sessionId:randomBytes(32).toString('hex'),authorityEpoch:1,hostConfirmed:true,snapshot:{membership:true,binding:null},createdAt:started,deadline:started+600000,stage:'durable' as const,reason:null,issued:true,outcomeKnown:true,issuedHash:createHash('sha256').update(issued.credential).digest('hex'),profileDigest,replaceProfile:null,intendedBinding:null,enableIntent:false,journalCommitId,remoteState:'issued'};
  createLocalJoin(home,journal,()=>true);
  await command('ack',{verifier,credentialHash:journal.issuedHash,profileDigest,journalCommitId});saveLocalJoin(home,{...journal,stage:'active'},()=>true);
  const member=new HubMemberClient({home,hubId:metadata.hub.hubId,memberOrigin:metadata.hub.memberOrigin,current:()=>true,
   reconcile:async()=>{online.add(binding.fleetId);},receive:async()=>{},hold:()=>{}});clients.push(member);await member.start().catch(()=>{});await wait(()=>online.has(binding.fleetId),60000);
  return{started,issued:true,binding,connected:Date.now()};
 }
 function people(prefix:string,n:number,groups:string[]=[]){return Array.from({length:n},(_,i)=>{const login=prefix+i;rig.people.push({id:randomUUID(),login,dn:'CN='+login+',DC=example,DC=test',password:'Dummy-'+login+'-only',groups});return login;});}
 async function wave(n:number,prefix:string,withGroups=false){
  const code=await create(n);secrets.push(code.code.replace('-',''));const persons=people(prefix,n),start=Date.now();
  const groupPeople=withGroups?people(prefix+'group',3,[group]):[];
  const result=await Promise.all([...persons.map((p,i)=>attempt(code.code,p,n===20&&i<5)),...groupPeople.map(p=>attempt(null,p))]);
  const uses=rig.db.prepare('SELECT uses FROM hub_enrolment_codes WHERE id=?').get(code.id).uses;
  check(prefix+' all issued and pinned member links online',result.every(r=>r.issued));check(prefix+' uses counted once',uses===n);
  const span=Math.max(...result.map(r=>r.started))-Math.min(...result.map(r=>r.started)),elapsed=Date.now()-start;
  check(prefix+' starts inside 60 seconds',span<60000);check(prefix+' connected within five minutes',elapsed<300000);
  const list=await rig.call(admin,'GET','/hub/v1/admin/enrolment-codes');check(prefix+' recent labels and owners',list.body.codes.find((c:any)=>c.id===code.id).recent.length===n);
  const extra=people(prefix+'extra',1)[0];check(prefix+' next push refuses after exhaustion',await attempt(code.code,extra).then(()=>false,(e:any)=>e.code==='denied'));
  receipt.waves.push({n,groups:groupPeople.length,startSpanMs:span,elapsedMs:elapsed,uses,online:online.size,hubRss:process.memoryUsage().rss,databaseBytes:statSync(join(rig.home,'hub/hub.sqlite')).size});
 }
 await wave(20,'small');await wave(50,'mass',true);
 const revoke=await create(50);secrets.push(revoke.code.replace('-',''));const names=people('revoke',50);
 const first=await Promise.all(names.slice(0,25).map(p=>attempt(revoke.code,p)));check('revoke first 25 issued',first.every(x=>x.issued));
 check('admin revokes mid-wave',(await rig.call(admin,'POST','/hub/v1/admin/enrolment-codes/'+revoke.id+'/revoke',{})).status===200);
 const rest=await Promise.all(names.slice(25).map(p=>attempt(revoke.code,p).then(()=>false,(e:any)=>e.code==='denied')));check('nothing issues after revocation',rest.every(Boolean));
 check('revoked counter stops at 25',rig.db.prepare('SELECT uses FROM hub_enrolment_codes WHERE id=?').get(revoke.id).uses===25);
 check('issued fleets stay active after code revocation',rig.deps.store.read().fleets.filter((f:any)=>f.status==='active').length===98);
 check('no join expired',rig.db.prepare("SELECT count(*) n FROM hub_company_join_requests WHERE json_extract(body,'$.reason')='expired'").get().n===0);
 const scan=(directory:string):boolean=>readdirSync(directory,{withFileTypes:true}).every(entry=>entry.isDirectory()?scan(join(directory,entry.name)):!secrets.some(s=>readFileSync(join(directory,entry.name)).includes(Buffer.from(s))));
 check('no plain code anywhere in Hub home',scan(rig.home));check('audit hash chain',rig.deps.audit.verifyChain().ok===true);receipt.ready=true;
}catch(error){receipt.error=String(error);console.error(error);process.exitCode=1;}
finally{
 for(const c of clients.reverse())await c.close().catch(()=>{});await browser?.close();await rig?.close();tls.connect=original;syncBuiltinESMExports();rmSync(root,{recursive:true,force:true});receipt.cleaned=true;
 const files=["src/hub/audit/index.ts", "src/hub/catalog.ts", "src/hub/client.ts", "src/hub/compose/member.ts", "src/hub/compose/server.ts", "src/hub/enrolment-code.ts", "src/hub/group-policy/admin-impact.ts", "src/hub/group-policy/admin-inventory.ts", "src/hub/group-policy/authorization.ts", "src/hub/group-policy/impact-inventory.ts", "src/hub/group-policy/resources.ts", "src/hub/group-policy/store.ts", "src/hub/http/compose.ts", "src/hub/join/receipt.ts", "src/hub/join/service.ts", "src/hub/join/store.ts", "src/hub/member/pairing-notices.ts", "src/hub/pairing-notices.ts", "src/hub/pairing.ts", "src/hub/protocol.ts", "src/hub/server.ts", "src/hub/types.ts", "src/settings-api.ts"];
 receipt.production=files.map(path=>({path,sha256:createHash('sha256').update(readFileSync('/work/'+path)).digest('hex')}));
 receipt.images=receipt.screenshots.map((path:string)=>({path,sha256:createHash('sha256').update(readFileSync(join(out,path))).digest('hex')}));writeFileSync(join(out,'receipt.json'),JSON.stringify(receipt,null,2));
}
console.log(JSON.stringify({ready:receipt.ready===true,checks:receipt.checks.length,error:receipt.error}));process.exit(receipt.ready?0:1);
