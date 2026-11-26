/** Real HTTP/UI + actual H/E/B/handler posting path. Synthetic owners; no Fleet start, CLI, vendor or accounts. */
import {createHash,randomUUID} from "node:crypto";
import {execFileSync} from "node:child_process";
import {readFileSync,mkdirSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {bootFixture,matrix,caseName} from "../smoke-fixture/index.mts";
const repo=process.env.REPO!,out=join(process.env.OUT!,"request-hub-relay-s232");mkdirSync(out,{recursive:true});
const git=(...args:string[])=>execFileSync("git",["-C",repo,...args],{encoding:"utf8"}).trim();
const receipt:any={sourceHead:git("rev-parse","HEAD"),dirtySource:git("status","--porcelain","--","src","scripts/manual/request-hub-relay-s232"),checks:[],pictures:[]};
const check=(name:string,ok:unknown)=>{receipt.checks.push({name,ok:!!ok});if(!ok)throw Error(name);};
const fx=await bootFixture({port:0,classic:false,host:true,roster:[{name:"lumen",displayName:"Lumen",backend:"claude-code"},{name:"atlas",displayName:"Atlas",backend:"codex"}]});
const {DeliveryOutbox}=await import(repo+"/src/delivery-outbox.ts"),{makeRequestContextRelay}=await import(repo+"/src/request-context-relay.ts"),{nativeAgentAdmissionContext}=await import(repo+"/src/native-agent-admission.ts"),{captureRequestContextCall}=await import(repo+"/src/request-context-call.ts"),{requestContextDigest}=await import(repo+"/src/request-context-store.ts"),{outboundHandlers}=await import(repo+"/src/outbound-handlers.ts"),{setLocale}=await import(repo+"/src/locale.ts");
const fm=fx.fm,box=new DeliveryOutbox(join(fx.dir,"relay-fixture.db"),"fixture",{requestContextDispatchVersion:1,requestContextRelayVersion:1});box.activateRequestContextBarrier();
const originalBox=fm.deliveryOutbox;fm.deliveryOutbox=box;fm.requestContextPolicy=fm.makeRequestContextPolicy();fm.requestContextRelay=makeRequestContextRelay(box,{current:()=>true,incarnation:()=>"runtime-v1",person:()=>null,adminOf:()=>false,canDecide:()=>true,canManage:()=>true});fm.getDaemonBootId=()=>"fixture-boot";fm.getInstanceStatus=()=>"running";fm.sendCancelButton=()=>{};fm.clearCancelButtonByCorrelation=()=>{};
const context=(room=false)=>{const id=randomUUID();return {ref:{version:1,contextId:id,rootContextId:id},rootEvidenceRef:"synthetic-accepted-question",ingress:"hub",initiatingActor:{kind:"person",platform:"hub",hubId:"demo-hub",id:"directory/demo-person",displayName:"Demo person"},source:{instance:"lumen",incarnation:"runtime-v1"},sourceAudience:{kind:room?"room":"hub",ref:randomUUID()}};};
async function post(c:any,tool:string,args:any){const owner={instance:c.source.instance,incarnation:"runtime-v1",workGeneration:"fixture-work",daemonBootId:"fixture-boot",spawnGeneration:1,launchFenceEpoch:0,deliveryEpoch:0},lease=captureRequestContextCall({token:randomUUID(),inputId:"fixture-input",context:c,wireSha256:requestContextDigest("fixture input"),owner},()=>true),ctx=nativeAgentAdmissionContext(fm,{instance:c.source.instance,current:()=>true,taskAllowed:()=>true,requestContext:lease,operation:{tool,args}});let result:any,error:any;await outboundHandlers.get(tool)!(ctx,args,(r:any,e:any)=>{result=r;error=e;},{instanceName:c.source.instance,operationId:randomUUID(),sourceDaemonBootId:"fixture-boot",requestContextAdmission:{coverage:"covered",lease}});return {result,error};}
try{
 for(const c of matrix()){
  fm.webChatHistory.forget("atlas");fm.webChatHistory.forget("lumen");
  setLocale(c.lang);const tag=caseName(c);
  const legacy=new Proxy(fm,{get(target,key){if(key==="requestContextPolicy"||key==="requestContextRelay")return undefined;if(key==="requestDeliveryView")return ()=>null;if(key==="admitDurableDelivery")return ()=>({deliveryId:"legacy-fixture",state:"queued",duplicate:false});const value=Reflect.get(target,key,target);return typeof value==="function"?value.bind(target):value;}});
  await outboundHandlers.get("request_information")!(legacy,{target_instance:"atlas",question:c.lang==="en"?"Can you check the public guide for this Hub question?":"請幫這個 Hub 問題查公開指南。"},()=>{},{instanceName:"lumen",sourceDaemonBootId:"fixture-boot",operationId:randomUUID()});
  const baseline=await fx.page(c,{path:"/ui/chat/atlas",host:true});try{await baseline.page.locator(".msg.status-line").last().waitFor();const path=join(out,`${tag}-before.png`);await baseline.page.screenshot({path});receipt.pictures.push({name:path.split("/").at(-1),sha256:createHash("sha256").update(readFileSync(path)).digest("hex")});}finally{await baseline.ctx.close();}
  fm.webChatHistory.forget("atlas");fm.webChatHistory.forget("lumen");
  const root=context(),start=await post(root,"request_information",{target_instance:"atlas",question:c.lang==="en"?"Can you check the public guide for this Hub question?":"請幫這個 Hub 問題查公開指南。",correlation_id:randomUUID()});check(`${tag}: actual request admitted`,!start.error&&box.listPending().length>0);
  const latest=box.listPending().at(-1)!,owner={instance:"atlas",incarnation:"runtime-v1",workGeneration:"fixture-work",daemonBootId:"fixture-boot",spawnGeneration:1,launchFenceEpoch:0,deliveryEpoch:0},child=box.prepareRequestContextDeliveryInput(latest.deliveryId,1,owner,requestContextDigest("actual formatted fixture wire"),()=>true);
  const {ctx,page}=await fx.page(c,{path:"/ui/chat/atlas",host:true});
  try{
   await page.locator(".request-provenance").last().waitFor();
   async function shot(state:string){const path=join(out,`${tag}-${state}.png`);await page.screenshot({path});receipt.pictures.push({name:path.split("/").at(-1),sha256:createHash("sha256").update(readFileSync(path)).digest("hex")});check(`${tag}-${state}: no overflow`,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
   await shot("relay");const returned=await post(child.context,"report_result",{target_instance:"lumen",summary:c.lang==="en"?"The public guide has the answer. Please share only what Demo person may see.":"公開指南有答案。請只分享可以讓 Demo person 看的內容。",correlation_id:latest.correlationId});check(`${tag}: exact return admitted`,!returned.error);
   await page.locator(".request-provenance").last().waitFor();await page.waitForTimeout(150);await shot("late-return");
   const group=context(true);await post(group,"send_to_instance",{instance_name:"atlas",message:c.lang==="en"?"Please prepare an answer suitable for everyone in the original room.":"請準備適合原房間所有成員看的回答。"});await page.waitForTimeout(150);await shot("room");
   const refused=await post(child.context,"delegate_task",{target_instance:"lumen",task:"Do later work"});check(`${tag}: mutation refused`,!!refused.error);await page.getByText(c.lang==="en"?"Not changed: Hub requests can't create or change later work.":"未變更：Hub 請求不能建立或修改延後執行的工作。",{exact:true}).last().waitFor();await shot("refusal");check(`${tag}: refusal stays fully wrapped`,await page.getByText(c.lang==="en"?"Not changed: Hub requests can't create or change later work.":"未變更：Hub 請求不能建立或修改延後執行的工作。",{exact:true}).last().evaluate((e:Element)=>!e.closest(".msg")!.classList.contains("folded")));
   const details=page.locator(".request-provenance details").last();await details.locator("summary").click();await shot("details");
   check(`${tag}: disclosure tap target`,c.device!=="phone"||await page.locator(".request-provenance summary").last().evaluate((e:Element)=>e.getBoundingClientRect().height>=44));
   check(`${tag}: request warning fully visible`,await page.locator(".request-provenance p").last().evaluate((e:Element)=>getComputedStyle(e).textOverflow!=="ellipsis"&&e.getBoundingClientRect().width>0));
  }finally{await ctx.close();}
 }
}finally{fm.requestContextPolicy=undefined;fm.requestContextRelay=undefined;fm.deliveryOutbox=originalBox;box.close();writeFileSync(join(out,"receipt.json"),JSON.stringify(receipt,null,2));await fx.close();}
