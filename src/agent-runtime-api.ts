import type {IncomingMessage,ServerResponse} from "node:http";
import type {WebApiContext} from "./web-api.js";
import {readBoundedWebBody} from "./web-body.js";
import {nativeCliAuthorization} from "./windows-cli-api.js";
function json(res:ServerResponse,status:number,value:unknown){if(!res.destroyed&&!res.writableEnded){res.writeHead(status,{"Content-Type":"application/json","Cache-Control":"no-store"});res.end(JSON.stringify(value));}}
/** Explicit dashboard-only runtime moves. Agent tool schemas do not offer this endpoint. */
export function handleAgentRuntimeChange(req:IncomingMessage,res:ServerResponse,url:URL,ctx:WebApiContext):boolean{
 const match=/^\/ui\/instances\/([^/]+)\/runtime$/.exec(url.pathname);if(!match)return false;
 const allowed=()=>nativeCliAuthorization(req,url,ctx);if(!allowed()){json(res,403,{error:"Runtime changes require a dashboard administrator"});return true;}
 let name:string;try{name=decodeURIComponent(match[1]);}catch{json(res,400,{error:"Invalid Agent name"});return true;}
 if(!Object.hasOwn(ctx.fleetConfig?.instances??{},name)){json(res,404,{error:"Agent not found"});return true;}
 if(!ctx.agentRuntimeChanges){json(res,503,{error:"Runtime changes are unavailable on this host"});return true;}
 if(req.method==="GET"){json(res,200,ctx.agentRuntimeChanges().describe(name));return true;}
 if(req.method!=="POST"){json(res,405,{error:"Method not allowed"});return true;}
 void(async()=>{
  try{
   const raw=await readBoundedWebBody(req,4096);if(!allowed()){json(res,403,{error:"Authorization expired"});return;}
   if(req.aborted||res.destroyed)return;
   const input=JSON.parse(raw.toString("utf8")),result=await ctx.agentRuntimeChanges!().change(name,input,allowed);
   json(res,200,result);
  }catch(error){json(res,allowed()?409:403,{error:allowed()?(error instanceof Error?error.message:"Could not change Runtime"):"Authorization expired"});}
 })();return true;
}
