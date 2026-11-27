/** Real web UI only: inert lifecycle ports; never a Fleet, CLI, provider, tmux or installer start. */
import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import {readFileSync,writeFileSync,mkdirSync} from "node:fs";
import {join} from "node:path";
import {bootFixture,matrix,caseName,shotPath} from "../smoke-fixture/index.mts";
const REPO=process.env.REPO!,OUT=process.env.OUT!,name="request-context-repair-m3896";
if(!REPO||!OUT)throw Error("REPO and OUT required");
const receipt:any={sourceHead:execFileSync("git",["-C",REPO,"rev-parse","HEAD"],{encoding:"utf8"}).trim(),
  scope:"Real web fixture, synthetic Draining status; lifecycle and changes refused. Not an activation or full-mode rig proof.",checks:[],pictures:[]};
const check=(label:string,ok:boolean)=>{receipt.checks.push({label,ok});if(!ok)throw Error(label);};
const fx=await bootFixture({port:0,classic:false,host:true,roster:[{name:"general",displayName:"General",backend:"mock"},{name:"agent-alpha",displayName:"Atlas",backend:"claude-code"}]});
const actions:string[]=[];
for(const method of ["startInstance","stopInstance","restartInstance","reconcile","prepareRequestContextFirstOnAssembly","stopRequestContextWork"]){
 fx.fm[method]=()=>{actions.push(method);throw Error("Lifecycle port refused in web capture");};
}
let view:any={revision:1,enabled:false,everActivated:true,attempted:true,phase:"draining",canChange:true,
 blockers:[{id:"work:synthetic-root:synthetic-image",kind:"work",labels:["Atlas"],agents:[{id:"agent-alpha",label:"Atlas"}],families:["turns","human-input"],unknownEnd:true,action:"stop-work"}],
 goBack:{attemptIds:["20261126T010203Z-0a1b2c3d"],availableUntil:new Date(Date.now()+3*86400000).toISOString(),timeZone:"UTC"}};
fx.fm.requestContextControl={principal:(req:any,url:any)=>fx.fm.requestContextControlPrincipal(req,url),snapshot:()=>structuredClone(view),read:()=>structuredClone(view),recheck:()=>structuredClone(view),permitContinuation:()=>true,
 change:()=>{actions.push("control-change");throw Error("Changes refused in web capture");}};
const pictures:string[]=[];
try{
 for(const c of matrix()){
  const tag=caseName(c),{ctx,page}=await fx.page(c,{host:true,path:"/settings/access"}),errors:string[]=[];
  page.on("pageerror",(e:any)=>errors.push(String(e)));
  try{
   view={...view,revision:view.revision+1,everActivated:true,phase:"draining",blockers:[{id:"work:synthetic-root:synthetic-image",kind:"work",labels:["Atlas"],agents:[{id:"agent-alpha",label:"Atlas"}],families:["turns","human-input"],unknownEnd:true,action:"stop-work"}]};
   await page.reload();const card=page.locator("#request-context");await card.getByText(c.lang==="en"?"The conversation's end isn't confirmed.":"無法確認這次對話是否已結束。",{exact:false}).waitFor();
   await card.scrollIntoViewIfNeeded();let path=shotPath(name,c,"draining");await card.screenshot({path});pictures.push(path);
   const stop=card.getByRole("button",{name:c.lang==="en"?"Stop this work · Atlas":"結束這項工作 · Atlas",exact:true});await stop.click();
   const dialog=page.getByRole("dialog");await dialog.waitFor();
   const warning=c.lang==="en"?"Stopping this work also ends Go back for this update.":"停止這項工作後，這次更新就不能再退回。";
   check(`${tag}: Go back consequence visible before Stop`,(await dialog.innerText()).includes(warning));
   path=shotPath(name,c,"stop-confirm");await dialog.screenshot({path});pictures.push(path);
   await page.keyboard.press("Escape");await dialog.waitFor({state:"hidden"});
   await page.goto(fx.base+"/ui/needs");const need=page.locator(".request-context-need").first();await need.waitFor();
   path=shotPath(name,c,"needs");await need.screenshot({path});pictures.push(path);
   view={...view,revision:view.revision+1,blockers:[{id:"work:synthetic-root:pending-fence-image",kind:"work",labels:["Atlas"],agents:[{id:"agent-alpha",label:"Atlas"}],families:["pending-stop"],unknownEnd:false,action:"stop-work"}]};
   await page.goto(fx.base+"/settings/access");const pending=page.locator("#request-context");
   await pending.getByRole("button",{name:c.lang==="en"?"Stop this work · Atlas":"結束這項工作 · Atlas",exact:true}).waitFor();
   await pending.scrollIntoViewIfNeeded();path=shotPath(name,c,"pending-stop");await pending.screenshot({path});pictures.push(path);
   view={...view,revision:view.revision+1,blockers:[{id:"work:synthetic-root:unknown-image",kind:"work",labels:["Atlas"],agents:[{id:"agent-alpha",label:"Atlas"}],families:["unknown"],unknownEnd:false,action:"inspect"}]};
   await page.goto(fx.base+"/settings/access");const unknown=page.locator("#request-context");await unknown.getByText(c.lang==="en"?"work that needs inspection":"需要檢查的工作",{exact:false}).waitFor();
   check(`${tag}: unknown state has no destructive action`,await unknown.getByRole("button",{name:/Stop this work|結束這項工作/}).count()===0);
   await unknown.scrollIntoViewIfNeeded();path=shotPath(name,c,"unknown");await unknown.screenshot({path});pictures.push(path);
   view={...view,revision:view.revision+1,everActivated:false,phase:"blocked",blockers:[{id:"legacy-uncertain:synthetic-delivery:"+"a".repeat(64),kind:"legacy",labels:["Atlas"],action:"acknowledge"}]};
   await page.reload();const legacy=page.locator("#request-context");
   const ack=legacy.getByRole("button",{name:c.lang==="en"?"Acknowledge":"確認",exact:true});await ack.waitFor();
   await legacy.scrollIntoViewIfNeeded();path=shotPath(name,c,"legacy-acknowledge");await legacy.screenshot({path});pictures.push(path);
   await ack.click();const acknowledge=page.getByRole("dialog");await acknowledge.waitFor();
   check(`${tag}: acknowledgement preserves unknown outcome`,(await acknowledge.innerText()).includes(c.lang==="en"?"The result is still unknown.":"結果仍不明。"));
   path=shotPath(name,c,"acknowledge-confirm");await acknowledge.screenshot({path});pictures.push(path);
   await page.keyboard.press("Escape");await acknowledge.waitFor({state:"hidden"});
   check(`${tag}: no page errors`,errors.length===0);
  }finally{await ctx.close();}
 }
 check("No lifecycle or change port called",actions.length===0);
}finally{
 receipt.pictures=pictures.map(path=>({file:path.split("/").at(-1),sha256:createHash("sha256").update(readFileSync(path)).digest("hex")}));
 mkdirSync(join(OUT,name),{recursive:true});writeFileSync(join(OUT,name,"receipt.json"),JSON.stringify(receipt,null,2)+"\n");await fx.close();
}
