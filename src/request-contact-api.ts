import { t } from "./locale.js";
/** Dormant transport. The real session/service host is uninstalled until cutover. */
import type {IncomingMessage,ServerResponse} from "node:http";
import {readBoundedWebBody} from "./web-body.js";
import {RequestContactDecisionV1Schema,type RequestContactCardV1,type RequestContactCardPageV1,type RequestContactDecisionV1,type RequestContactPrincipal,type RequestContactListFilter,type RequestContactNeedV1} from "./request-contact-types.js";
export interface RequestContactApiHost {
 principal(req:IncomingMessage,url:URL):RequestContactPrincipal|null;
 needs?(actor:RequestContactPrincipal):RequestContactNeedV1[];
 permitContinuation(req:IncomingMessage,res:ServerResponse):boolean;
 /** Synchronous final target-role/incarnation check, including after an awaited read or decision. */
 canRead(card:RequestContactCardV1,actor:RequestContactPrincipal):boolean;
 read(id:string,actor:RequestContactPrincipal):RequestContactCardV1|Promise<RequestContactCardV1>;
 list(filter:RequestContactListFilter,actor:RequestContactPrincipal):RequestContactCardPageV1|Promise<RequestContactCardPageV1>;
 decide(id:string,input:RequestContactDecisionV1,actor:RequestContactPrincipal):RequestContactCardV1|Promise<RequestContactCardV1>;
}
function answer(res:ServerResponse,status:number,value:unknown):void {
 if(res.destroyed||res.writableEnded)return;
 res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"});res.end(JSON.stringify(value));
}
function alive(principal:RequestContactPrincipal|null):principal is RequestContactPrincipal {try{return !!principal&&principal.current();}catch{return false;}}
function same(a:RequestContactPrincipal,b:RequestContactPrincipal):boolean{return a.binding===b.binding&&a.person.platform===b.person.platform&&a.person.userId===b.person.userId;}
const states=new Set(["pending","approved","delivered","declined","expired","unknown","all"]);
/** Every post-await read rechecks the same admitted session/account. Role/CAS also belong inside the service/writer. */
export function handleRequestContactApi(req:IncomingMessage,res:ServerResponse,url:URL,host?:RequestContactApiHost):boolean {
 const route=/^\/ui\/api\/request-contact-authorizations(?:\/(R[a-f0-9-]{36})(\/decision)?)?$/.exec(url.pathname);
 if(!route)return false;
 if(!host){answer(res,404,{error:"not-found"});return true;}
 const method=req.method??"GET",id=route[1],decision=!!route[2];
 if(!(method==="GET"&&!decision)&&!(method==="POST"&&decision)){answer(res,405,{error:"method-not-allowed"});return true;}
 let first:RequestContactPrincipal|null;try{first=host.principal(req,url);}catch(error){const code=error instanceof Error?error.message:"unavailable";answer(res,["csrf","cross-site"].includes(code)?403:503,{error:["csrf","cross-site"].includes(code)?code:"unavailable"});return true;}
 if(!alive(first)){answer(res,401,{error:"sign-in-required"});return true;}
 if(method==="POST"&&!first.verified){answer(res,403,{error:"verification-required"});return true;}
 const current=():RequestContactPrincipal=>{const now=host.principal(req,url);if(!alive(first)||!alive(now)||!same(first,now))throw Error("forbidden");return now;};
 void(async()=>{
  try{
   if(method==="GET"){
    let value:RequestContactCardV1|RequestContactCardPageV1;
    if(id){if(url.searchParams.size)throw Error("invalid-request");value=await host.read(id,first);}
    else{
     const entries=[...url.searchParams];if(entries.some(([key,value])=>!["agent","status","cursor"].includes(key)||!value||value.length>2048)||new Set(entries.map(([key])=>key)).size!==entries.length)throw Error("invalid-request");
     const filter=Object.fromEntries(entries)as RequestContactListFilter;
     if(filter.status&&!states.has(filter.status))throw Error("invalid-request");
     value=await host.list(filter,first);
    }
    const actor=current();
    if("items" in value)value={...value,items:value.items.filter(card=>host.canRead(card,actor))};
    else if(!host.canRead(value,actor))throw Error("not-found");
    answer(res,200,value);return;
   }
   const bytes=await readBoundedWebBody(req,48*1024);const actor=current();
   if(!actor.verified){answer(res,403,{error:"verification-required"});return;}
   if(!host.permitContinuation(req,res))return;
   let body:unknown;try{body=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));}catch{throw Error("invalid-request");}
   const parsed=RequestContactDecisionV1Schema.safeParse(body);if(!parsed.success||!id||url.searchParams.size)throw Error("invalid-request");
   if(parsed.data.grant&&Date.parse(parsed.data.grant.expiresAt)<=Date.now())throw Error("invalid-grant");
   const latest=current();if(!latest.verified)throw Error("verification-required");
   const result=await host.decide(id,parsed.data,latest);
   const viewer=current();if(!host.canRead(result,viewer))throw Error("not-found");answer(res,200,result);
  }catch(error){
   if(error&&typeof error==="object"&&"code" in error&&error.code==="request-context-legacy-decision-upgrade-required"){answer(res,409,{error:"upgrade-required",message:t("contact.legacyUpgrade")});return;}
   const code=error instanceof Error?error.message:"unavailable";
   const status=["forbidden","verification-required","csrf","cross-site"].includes(code)?403:code==="not-found"?404
    :["conflict","policy-conflict","operation-conflict","expired","already-decided","stale-generation"].includes(code)?409
    :["invalid-request","invalid-grant","invalid-grant-origin","invalid-cursor"].includes(code)?400:503;
   answer(res,status,{error:status===503?"unavailable":code});
  }
 })();return true;
}
