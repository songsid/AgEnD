// Real dashboard/server, synthetic historical unknown contact origin; no daemons, model or account calls.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { bootFixture, matrix } from "../smoke-fixture/index.mts";
const out=process.env.OUT!;mkdirSync(out,{recursive:true});
const fx=await bootFixture({port:0,host:true,classic:false,roster:[{name:"demo-source",backend:"codex",displayName:"Demo source"},{name:"demo-target",backend:"codex",displayName:"Demo target"}]});
const {DeliveryOutbox}=await import(process.env.REPO+"/src/delivery-outbox.ts");
const {setLocale}=await import(process.env.REPO+"/src/locale.ts");
const fm=fx.fm,db=new DeliveryOutbox(join(fx.dir,"synthetic-outbox.db")),store=db.contactAuthorizations;
fm.deliveryOutbox=db;fm.scheduleDeliveryOutboxPump=()=>{};fm.contactGeneration=(name:string)=>`synthetic-${name}`;
const origin={kind:"unknown",people:[],receiptIds:[],chain:["demo-source"]};
store.inheritOrigin("demo-source",origin);
const tk=store.hold({operationId:"synthetic-contact",source:"demo-source",target:"demo-target",sourceGeneration:fm.contactGeneration("demo-source"),targetGeneration:fm.contactGeneration("demo-target"),verb:"send_to_instance",origin,message:"Please summarize the public example status page.",correlationId:"synthetic-contact",resultRecipient:"demo-source",payload:{type:"fleet_inbound",content:"Synthetic public-information question"}});
fm.startNeedsYou();const results:any[]=[];
try{
 for(const c of matrix()){
  setLocale(c.lang);fm.needsYou.recompute();
  const {page,ctx,csp}=await fx.page(c,{host:true,path:"/ui/needs"});const errors:string[]=[];page.on("pageerror",(e:Error)=>errors.push(e.message));
  const reason=page.locator(`[data-ticket="${tk.id}"] .contact-reason`).first();await reason.waitFor();
  if(process.env.STAGE!=="before")await reason.getByText(c.lang==="en"?"Clear retained origin":"清除保留的來源",{exact:false}).waitFor();
  await reason.scrollIntoViewIfNeeded();
  await page.screenshot({path:join(out,`${c.device}-${c.theme}-${c.lang}-needs.png`)});
  const needsCsp=await csp();
  if(process.env.NEEDS_ONLY==="1"){
   const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
   const text=await reason.innerText();
   if(!(c.lang==="en"?text.startsWith("Demo source's retained history"):text.startsWith("Demo source 保留的歷史"))||!(c.lang==="en"?text.includes("Demo source → Settings → Permissions"):text.includes("Demo source 的「設定」→「權限」")))throw Error("Missing sender display name/full recovery path");
   if(overflow||errors.length||needsCsp.length)throw Error(JSON.stringify({overflow,errors,csp:needsCsp}));
   results.push({...c,overflow,errors,csp:needsCsp,recoveryText:text});await ctx.close();continue;
  }
  await page.goto(`${fx.base}/ui/fleet/agent/demo-source?cat=permissions`);
  const clear=page.getByRole("button",{name:c.lang==="en"?"Clear retained origin":"清除保留的來源",exact:true});await clear.waitFor();
  if(c.device==="phone"){const box=await clear.boundingBox();if(!box||box.height<44)throw Error("Small recovery tap target");}
  await clear.scrollIntoViewIfNeeded();
  await page.screenshot({path:join(out,`${c.device}-${c.theme}-${c.lang}-permissions.png`)});
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
  const cspErrors=[...needsCsp,...await csp()];
  if(overflow||errors.length||cspErrors.length)throw Error(JSON.stringify({overflow,errors,csp:cspErrors}));
  results.push({...c,overflow,errors,csp:cspErrors,clearEnabled:await clear.isEnabled()});await ctx.close();
 }
 writeFileSync(join(out,"receipt.json"),JSON.stringify({stage:process.env.STAGE??"after",sourceHead:execFileSync("git",["rev-parse","HEAD"],{cwd:process.env.REPO,encoding:"utf8"}).trim(),results},null,2));
}finally{await fm.needsYou.stop();await fx.close();db.close();}
