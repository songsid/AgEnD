/** Direct HTTPS Hub door; OAuth backchannels never borrow cookie authentication or an agent socket. */
import type {IncomingMessage,ServerResponse} from "node:http";
import {StreamableHTTPServerTransport} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {HubMcpAuth,HubMcpOAuthError,HUB_MCP_SCOPES} from "./auth.js";
import {HubMcpPolicy} from "./policy.js";
import {HubMcpTools,type HubMcpServices} from "./tools.js";
import {hubPersonMcp} from "./server.js";
import type {HubCore} from "../http/core.js";
import type {HubSessions} from "../sessions.js";
import {HubProtocolError,parseStrictJson} from "../validation.js";

const paths=new Set(["/mcp","/.well-known/oauth-protected-resource","/.well-known/oauth-protected-resource/mcp","/.well-known/oauth-authorization-server",
  "/mcp/oauth/register","/mcp/oauth/authorize","/mcp/oauth/token","/mcp/oauth/revoke","/hub/v1/me/ai-apps","/hub/v1/mcp/consent","/hub/v1/admin/ai-apps","/hub/v1/admin/ai-apps/search"]);
function json(res:ServerResponse,status:number,value:unknown,headers:Record<string,string>={}) {
  if(res.destroyed||res.writableEnded)return;
  res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer",...headers});res.end(JSON.stringify(value));
}
function fields(params:URLSearchParams):Record<string,string> {
  const value:Record<string,string>={};for(const [key,v]of params){if(Object.hasOwn(value,key))throw new HubProtocolError("invalid");Object.defineProperty(value,key,{value:v,enumerable:true});}return value;
}
async function body(req:IncomingMessage,form=false):Promise<unknown> {
  if(req.headers["content-encoding"]!==undefined)throw new HubProtocolError("invalid");
  const type=String(req.headers["content-type"]??"").split(";")[0]?.trim().toLowerCase();
  if(type!==(form?"application/x-www-form-urlencoded":"application/json"))throw new HubProtocolError("invalid");
  const declared=req.headers["content-length"];if(declared!==undefined&&(!/^\d+$/.test(declared)||Number(declared)>128*1024))throw new HubProtocolError("backpressure");
  const read=async()=>{const chunks:Buffer[]=[];let size=0;for await(const part of req){const b=Buffer.from(part);size+=b.length;if(size>128*1024)throw new HubProtocolError("backpressure");chunks.push(b);}const bytes=Buffer.concat(chunks);
    return form?fields(new URLSearchParams(new TextDecoder("utf-8",{fatal:true}).decode(bytes))):parseStrictJson(bytes,128*1024);};
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([read(),new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{reject(new HubProtocolError("unavailable"));req.destroy();},5000);timer.unref();})]);}
  finally{if(timer)clearTimeout(timer);}
}
export class HubMcpDoor {
  readonly policy:HubMcpPolicy;readonly auth:HubMcpAuth;readonly tools:HubMcpTools;
  private closed=false;private active=0;private readonly perApp=new Map<string,number>();
  private readonly transports=new Set<StreamableHTTPServerTransport>();
  private readonly buckets=new Map<string,{window:number;used:number}>();
  constructor(private readonly core:HubCore,private readonly sessions:HubSessions,services:HubMcpServices) {
    this.policy=new HubMcpPolicy(core,reason=>this.auth.revokePolicyGrants({kind:"all"},reason));this.auth=new HubMcpAuth(core,this.policy);this.tools=new HubMcpTools(core,this.policy,services);
  }
  private live(){return !this.closed&&this.core.live();}
  private admission(req:IncomingMessage) {
    const now=this.core.now(),window=Math.floor(now/60_000)*60_000,key=req.socket.remoteAddress??"unknown";
    for(const [id,b]of this.buckets)if(b.window<window)this.buckets.delete(id);
    const old=this.buckets.get(key);if(old?old.window>window||old.used>=120:this.buckets.size>=1024)throw new HubProtocolError("backpressure");
    this.buckets.set(key,{window,used:(old?.used??0)+1});
  }
  handle(req:IncomingMessage,res:ServerResponse,url:URL):boolean {
    const owned=paths.has(url.pathname)||/^\/hub\/v1\/me\/ai-apps\/[a-f0-9-]{36}$/.test(url.pathname)||/^\/hub\/v1\/rooms\/[a-f0-9-]{36}\/ai-apps$/.test(url.pathname);
    if(!owned)return false;
    void this.route(req,res,url).catch(error=>{
      if(url.pathname==="/mcp"&&(error instanceof HubMcpOAuthError&&error.error!=="temporarily_unavailable"||error instanceof HubProtocolError&&["denied","revoked"].includes(error.code)))return json(res,401,{error:"invalid_token",message:"Sign in again."},{"WWW-Authenticate":`Bearer resource_metadata="${this.core.deps.config.webOrigin}/.well-known/oauth-protected-resource/mcp"`});
      if(error instanceof HubMcpOAuthError)return json(res,error.error==="temporarily_unavailable"?503:400,{error:error.error});
      const code=error instanceof HubProtocolError?error.code:"unavailable";
      json(res,code==="denied"||code==="revoked"?403:code==="backpressure"?429:code==="not-found"?404:code==="invalid"?400:503,{code});
    });return true;
  }
  private async route(req:IncomingMessage,res:ServerResponse,url:URL) {
    if(!this.live())throw new HubProtocolError("unavailable");
    const path=url.pathname,method=req.method??"GET",origin=this.core.deps.config.webOrigin;
    if(path.startsWith("/.well-known/")) {
      if(method!=="GET"||url.searchParams.size)throw new HubProtocolError("invalid");
      return json(res,200,path.endsWith("oauth-authorization-server")?{issuer:origin,authorization_endpoint:`${origin}/mcp/oauth/authorize`,token_endpoint:`${origin}/mcp/oauth/token`,
        registration_endpoint:`${origin}/mcp/oauth/register`,revocation_endpoint:`${origin}/mcp/oauth/revoke`,response_types_supported:["code"],grant_types_supported:["authorization_code","refresh_token"],
        token_endpoint_auth_methods_supported:["none"],code_challenge_methods_supported:["S256"],scopes_supported:HUB_MCP_SCOPES}:
        {resource:this.auth.resource,authorization_servers:[origin],scopes_supported:HUB_MCP_SCOPES,bearer_methods_supported:["header"]});
    }
    if(req.headers.origin!==undefined&&req.headers.origin!==origin)throw new HubProtocolError("denied");
    if(path.startsWith("/mcp/oauth/"))this.admission(req);
    if(path==="/mcp/oauth/register") {if(method!=="POST"||url.searchParams.size)throw new HubProtocolError("invalid");return json(res,201,this.auth.register(await body(req)));}
    if(path==="/mcp/oauth/authorize") {
      if(method!=="GET")throw new HubProtocolError("invalid");const pending=this.auth.begin(fields(url.searchParams));
      res.writeHead(302,{Location:`/ui/hub?view=app-consent&request=${encodeURIComponent(pending.request)}`,"Cache-Control":"no-store","Referrer-Policy":"no-referrer"});res.end();return;
    }
    if(path==="/mcp/oauth/token"||path==="/mcp/oauth/revoke") {
      if(method!=="POST"||url.searchParams.size)throw new HubProtocolError("invalid");
      const input=await body(req,true) as Record<string,string>;
      if(path.endsWith("revoke")){this.auth.revoke(input);return json(res,200,{});}
      const {grant_type,...params}=input;
      const result=grant_type==="authorization_code"?await this.auth.exchangeCode(params):grant_type==="refresh_token"?await this.auth.refresh(params):null;
      if(!result)throw new HubMcpOAuthError("invalid_request");return json(res,200,result);
    }
    if(path==="/mcp") {
      if(url.searchParams.size)throw new HubProtocolError("invalid");
      const authorization=req.headers.authorization,token=typeof authorization==="string"&&/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization)?authorization.slice(7):null;
      if(!token)return json(res,401,{error:"invalid_token"},{"WWW-Authenticate":`Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="${HUB_MCP_SCOPES.join(" ")}"`});
      const p=await this.auth.authenticate(token);
      if(method!=="POST"){json(res,405,{code:"method"},{Allow:"POST"});return;}
      if(this.active>=32||(this.perApp.get(p.appId)??0)>=4)throw new HubProtocolError("backpressure");
      this.active++;this.perApp.set(p.appId,(this.perApp.get(p.appId)??0)+1);
      const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true}),server=hubPersonMcp({...p,context:{...p.context,
        isCurrent:()=>p.context.isCurrent?.()===true&&this.live()&&!req.aborted&&!res.destroyed&&!res.writableEnded}},this.tools);
      this.transports.add(transport);let finished=false;
      const close=()=>{if(finished)return;finished=true;this.active--;const n=(this.perApp.get(p.appId)??1)-1;if(n)this.perApp.set(p.appId,n);else this.perApp.delete(p.appId);
        this.transports.delete(transport);void server.close().catch(()=>{});};
      const timeout=setTimeout(()=>{json(res,503,{code:"unavailable"});close();},30_000);timeout.unref();
      res.once("close",()=>{clearTimeout(timeout);close();});
      try{const input=await body(req);if(!this.live()||res.writableEnded)throw new HubProtocolError("unavailable");await server.connect(transport);await transport.handleRequest(req,res,input);}
      catch(error){clearTimeout(timeout);close();throw error;}return;
    }
    const ctx=this.sessions.context(req),mutation=method!=="GET";
    if(mutation){const session=this.sessions.session(ctx.token);if(!this.sessions.sameOrigin(req)||!session||!this.sessions.csrfOk(req,session.token))throw new HubProtocolError("denied");}
    if(path==="/hub/v1/mcp/consent") {
      if(method==="GET"){if(url.searchParams.size!==1||!url.searchParams.has("request"))throw new HubProtocolError("invalid");return json(res,200,await this.auth.preview(ctx,url.searchParams.get("request")!));}
      if(method!=="POST"||url.searchParams.size)throw new HubProtocolError("invalid");
      const value=await body(req) as {request?:unknown;scopes?:unknown;cancel?:unknown};
      if(!value||typeof value.request!=="string"||Object.keys(value).some(k=>!["request","scopes","cancel"].includes(k)))throw new HubProtocolError("invalid");
      const location=value.cancel===true?this.auth.cancel(value.request):await this.auth.approve(ctx,value.request,value.scopes);return json(res,200,{location});
    }
    if(path==="/hub/v1/me/ai-apps"){
      if(method!=="GET"||url.searchParams.size)throw new HubProtocolError("invalid");const apps=await this.auth.list(ctx),who=await ctx.requirePerson();let available=true;
      try{const permit=await this.policy.authorize(who,()=>ctx.isCurrent?.()===true);permit.assertCurrent();}catch(error){if(error instanceof HubProtocolError&&error.code==="denied")available=false;else throw error;}
      if(ctx.isCurrent?.()!==true)throw new HubProtocolError("revoked");return json(res,200,{apps,address:this.auth.resource,available});
    }
    if(path.startsWith("/hub/v1/me/ai-apps/")){if(method!=="DELETE"||url.searchParams.size)throw new HubProtocolError("invalid");await this.auth.disconnect(ctx,path.split("/").at(-1)!);return json(res,200,{ok:true});}
    if(path==="/hub/v1/admin/ai-apps/search") {
      if(method!=="GET")throw new HubProtocolError("invalid");return json(res,200,await this.policy.search(ctx,fields(url.searchParams)));
    }
    if(path==="/hub/v1/admin/ai-apps") {
      if(url.searchParams.size)throw new HubProtocolError("invalid");
      if(method==="GET")return json(res,200,await this.policy.settings(ctx));
      if(method==="PATCH")return json(res,200,await this.policy.save(ctx,await body(req)));throw new HubProtocolError("invalid");
    }
    const roomId=path.split("/")[4]!;
    if(method!=="PATCH"||url.searchParams.size)throw new HubProtocolError("invalid");const value=await body(req) as {enabled?:unknown};
    if(!value||Object.keys(value).length!==1)throw new HubProtocolError("invalid");return json(res,200,await this.policy.saveRoom(ctx,roomId,value.enabled));
  }
  async close(){this.closed=true;this.buckets.clear();await Promise.all([...this.transports].map(t=>t.close().catch(()=>{})));this.transports.clear();}
}
