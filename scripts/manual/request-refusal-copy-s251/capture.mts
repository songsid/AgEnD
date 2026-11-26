/** S-251: actual posting + web renderer, synthetic people, private scratch only. No Fleet/CLI/provider start. */
import {createHash,randomUUID} from "node:crypto";
import {execFileSync} from "node:child_process";
import {mkdirSync,readFileSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {bootFixture,matrix,caseName} from "../smoke-fixture/index.mts";
const repo=process.env.REPO!,out=join(process.env.OUT!,"request-refusal-copy-s251");mkdirSync(out,{recursive:true});
const git=(...args:string[])=>execFileSync("git",["-C",repo,...args],{encoding:"utf8"}).trim();
const receipt:any={sourceHead:git("rev-parse","HEAD"),dirtySource:git("status","--porcelain","--","src","scripts/manual/request-refusal-copy-s251"),checks:[],pictures:[],decisions:[]};
const check=(name:string,ok:unknown)=>{receipt.checks.push({name,ok:!!ok});if(!ok)throw Error(name);};
const fx=await bootFixture({port:0,classic:false,host:true,roster:[{name:"lumen",displayName:"Lumen",backend:"claude-code"},{name:"atlas",displayName:"Atlas",backend:"codex"}]});
const {nativeAgentAdmissionContext}=await import(repo+"/src/native-agent-admission.ts"),{captureRequestContextCall}=await import(repo+"/src/request-context-call.ts"),{requestContextDigest}=await import(repo+"/src/request-context-store.ts"),{outboundHandlers}=await import(repo+"/src/outbound-handlers.ts"),{setLocale}=await import(repo+"/src/locale.ts"),{REQUEST_CONTEXT_POLICY_COPY}=await import(repo+"/src/request-context-policy.ts");
const fm=fx.fm,basePolicy=fm.makeRequestContextPolicy();let mutationCalls=0;
// A failed refusal probe must never reach a live-capable lifecycle or persistence sink, even in a broken build.
const stopped=()=>{mutationCalls++;throw Error("Unexpected fixture mutation");};
fm.saveFleetConfig=stopped;fm.admitDurableDelivery=stopped;fm.lifecycle.handleCreate=stopped;
let seen:any[]=[];fm.requestContextPolicy={assert(input:any){try{return basePolicy.assert(input);}catch(error:any){seen.push({code:error.code,reason:error.reason});throw error;}}};
const context=(ingress:"hub"|"guest")=>{const id=randomUUID();return{ref:{version:1,contextId:id,rootContextId:id},rootEvidenceRef:"synthetic-accepted-request",ingress,initiatingActor:ingress==="hub"?{kind:"person",platform:"hub",hubId:"demo-hub",id:"directory/demo-person",displayName:"Demo person"}:{kind:"person",platform:"discord",userId:"demo-person"},source:{instance:"lumen",incarnation:"runtime-v1"},sourceAudience:{kind:ingress==="hub"?"hub":"room",ref:randomUUID()}};};
const cases=[{name:"uncovered",ingress:null,tool:"update_instance_config",args:{name:"atlas",config:{description:"Must not change"}}},{name:"outside",ingress:"guest",tool:"create_instance",args:{topic_name:"Not created"}},{name:"settings",ingress:"hub",tool:"update_instance_config",args:{name:"atlas",config:{description:"Must not change"}}},{name:"broadcast",ingress:"hub",tool:"broadcast",args:{message:"Not sent"}}]as const;
try{
 for(const variant of matrix())for(const c of cases){
  const tag=`${caseName(variant)}-${c.name}`;setLocale(variant.lang);fm.webChatHistory.forget("lumen");fm.webChatHistory.forget("atlas");seen=[];
  const before=JSON.stringify(fm.fleetConfig),root=c.ingress?context(c.ingress):undefined,owner={instance:"lumen",incarnation:"runtime-v1",workGeneration:"fixture-work",daemonBootId:"fixture-boot",spawnGeneration:1,launchFenceEpoch:0,deliveryEpoch:0};
  const lease=root?captureRequestContextCall({token:randomUUID(),inputId:"fixture-input",context:root,wireSha256:requestContextDigest("synthetic input"),owner},()=>true):undefined;
  const admission=lease?{coverage:"covered",lease}:{coverage:"not-covered",reason:"unbound-input"},ctx=nativeAgentAdmissionContext(fm,{instance:"lumen",current:()=>true,taskAllowed:()=>true,...(lease?{requestContext:lease}:{notCoveredReason:"unbound-input"}),operation:{tool:c.tool,args:c.args}});
  let result:any,error:any;await outboundHandlers.get(c.tool)!(ctx,c.args,(r:any,e:any)=>{result=r;error=e;},{instanceName:"lumen",operationId:randomUUID(),sourceDaemonBootId:"fixture-boot",requestContextAdmission:admission});
  const expected=REQUEST_CONTEXT_POLICY_COPY[variant.lang][c.name];check(`${tag}: exact real refusal`,result===null&&error===expected);check(`${tag}: stable code`,seen.length===1&&seen[0].code===`request-context-${c.name}`);check(`${tag}: no mutation`,mutationCalls===0&&before===JSON.stringify(fm.fleetConfig));
  receipt.decisions.push({variant:caseName(variant),state:c.name,tool:c.tool,code:seen[0].code,text:error,sideEffects:mutationCalls});
  const {ctx:browserContext,page}=await fx.page(variant,{path:"/ui/chat/lumen",host:true});
  try{
   const text=page.getByText(expected,{exact:true}).last();await text.waitFor();await page.mouse.move(1,1);await page.evaluate(()=>{(document.activeElement as HTMLElement|null)?.blur?.();});
   check(`${tag}: notice fully wrapped`,await text.evaluate((e:Element)=>{const row=e.closest(".msg");return !!row&&!row.classList.contains("folded")&&getComputedStyle(e).textOverflow!=="ellipsis";}));
   check(`${tag}: no horizontal overflow`,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   check(`${tag}: truthful provenance`,c.ingress==="hub"?await page.locator(".request-provenance strong").last().innerText()===(variant.lang==="en"?"Relayed for Demo person · Hub":"代 Demo person 傳話 · Hub"):await page.locator(".request-provenance").count()===0);
   const name=tag+".png",file=join(out,name);await page.screenshot({path:file});receipt.pictures.push({name,sha256:createHash("sha256").update(readFileSync(file)).digest("hex")});
  }finally{await browserContext.close();}
 }
 check("all32 requested frames",receipt.pictures.length===matrix().length*cases.length&&receipt.pictures.length>0);
}finally{fm.requestContextPolicy=undefined;writeFileSync(join(out,"receipt.json"),JSON.stringify(receipt,null,2));await fx.close();}
