/** Per-turn, instance-bound MCP capabilities for native Windows CLI children. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { dispatchAgentOperation, type AgentEndpointContext } from "./agent-endpoint.js";
import { TOOLS, OUTBOUND_TOOL_SCHEMAS } from "./channel/mcp-tools.js";
import { dashboardRefusalIn } from "./dashboard-permissions.js";
import { gatewayRequestContext } from "./web-request-context.js";
import { readBoundedWebBody } from "./web-body.js";
import { mayUseTool, resolveToolSet } from "./tool-permissions.js";
import type { NativeMcpConnection, NativeSandbox } from "./windows-cli-providers.js";

const HEADER = "x-agend-native-token";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const TTL_MS = 6 * 60_000;
const MAX_BYTES = 64 * 1024;
const MAX_CALLS = 64;
const OPS: Readonly<Record<string,string>> = Object.freeze({
  list_instances:"list", describe_instance:"describe", task:"task", send_to_instance:"send",
  delegate_task:"delegate", request_information:"ask", report_result:"report", delivery_status:"delivery-status",
});
const READ_TOOLS = new Set(["list_instances","describe_instance","task","delivery_status"]);
const READ_TASK_ACTIONS = ["list","get","mine","projects"];
type ToolResult = { content:Array<{type:"text";text:string}>;isError?:boolean };
interface Call { digest:string; result:Promise<ToolResult> }
interface Session {
  token:string; instance:string; requestId:string; agentId:string; backend:string;
  sandbox:NativeSandbox; expires:number; stillCurrent:()=>boolean; closed:boolean;
  timer:ReturnType<typeof setTimeout>; calls:Map<string,Call>; reported:Map<string,Set<string>>;
}
export interface NativeMcpGrant {
  instance:string; requestId:string; sandbox:NativeSandbox; endpoint:string; stillCurrent:()=>boolean;
}
export interface NativeMcpLease {
  connection:NativeMcpConnection;
  close():void;
  reportedCorrelations(targetInstance?:string):string[];
}

function object(value:unknown):value is Record<string,unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function endpoint(value:string):string {
  const url=new URL(value);
  if(url.protocol!=="http:" || !["127.0.0.1","localhost","[::1]"].includes(url.hostname)
    || url.pathname!=="/agent" || url.search || url.hash || url.username || url.password) throw Error("Native MCP requires the local agent endpoint");
  return url.href;
}
function loopback(address:string|undefined):boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}
function canonical(value:unknown,depth=0):string {
  if(depth>64)throw Error("Native MCP arguments are too deeply nested");
  if(Array.isArray(value))return `[${value.map(item=>canonical(item,depth+1)).join(",")}]`;
  if(object(value))return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key],depth+1)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function toolError(message:string):ToolResult { return {content:[{type:"text",text:message.slice(0,4000)}],isError:true}; }
function failed(value:unknown):boolean { return object(value) && value.error!==undefined; }
function result(value:unknown):ToolResult {
  const text=typeof value === "string" ? value : JSON.stringify(value);
  if(text===undefined)return toolError("AgEnD returned no tool result");
  const response:ToolResult={content:[{type:"text",text}],...(failed(value)?{isError:true}:{})};
  if(Buffer.byteLength(JSON.stringify(response))>MAX_BYTES) {
    const operation=object(value) && typeof value.operation_id === "string" ? ` Operation ID: ${value.operation_id}.` : "";
    return toolError(`Tool result exceeds the native MCP response limit.${operation} Use a narrower query; do not repeat a mutation whose outcome is unknown.`);
  }
  return response;
}
function json(res:ServerResponse,status:number,value:unknown):void {
  if(res.destroyed || res.writableEnded)return;
  res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"});
  res.end(JSON.stringify(value));
}
function refuse(req:IncomingMessage,res:ServerResponse,status:number,message:string):void {
  if(!res.destroyed && !res.writableEnded){res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","Connection":"close"});res.end(JSON.stringify({error:message}));}
  req.resume();
}

export class NativeMcpSessions {
  private readonly sessions=new Map<string,Session>();
  constructor(private readonly ctx:AgentEndpointContext) {}

  grant(input:NativeMcpGrant):NativeMcpLease {
    this.prune();
    const config=this.ctx.fleetConfig?.instances[input.instance];
    if(process.env.AGEND_WINDOWS_CLI!=="1" || config?.runtime!=="windows" || !UUID.test(config.native_agent_id ?? "")
      || !["codex","claude-code"].includes(config.backend ?? "") || !UUID.test(input.requestId)
      || !["read-only","workspace-write"].includes(input.sandbox) || typeof input.stillCurrent!=="function") throw Error("Native MCP requires an active supported Windows instance");
    if(this.sessions.size>=16 || [...this.sessions.values()].some(session=>session.instance===input.instance)) throw Error("A native MCP session is already active or the session limit was reached");
    const address=endpoint(input.endpoint), token=randomBytes(32).toString("hex");
    const session:Session={token,instance:input.instance,requestId:input.requestId,agentId:config.native_agent_id!,backend:config.backend!,sandbox:input.sandbox,
      expires:Date.now()+TTL_MS,stillCurrent:input.stillCurrent,closed:false,calls:new Map(),reported:new Map(),
      timer:setTimeout(()=>this.closeToken(token),TTL_MS)};
    session.timer.unref?.();this.sessions.set(token,session);
    return {connection:{endpoint:address,token,tools:this.menu(session).map(tool=>tool.name)},close:()=>this.closeToken(token),
      reportedCorrelations:target=>target===undefined ? [...new Set([...session.reported.values()].flatMap(ids=>[...ids]))] : [...(session.reported.get(target) ?? [])]};
  }
  hasActive(instance:string):boolean {
    this.prune();return [...this.sessions.values()].some(session=>session.instance===instance);
  }
  closeInstance(instance:string):void { for(const session of this.sessions.values())if(session.instance===instance)this.closeToken(session.token); }
  closeAll():void { for(const token of this.sessions.keys())this.closeToken(token); }
  private closeToken(token:string):void {
    const session=this.sessions.get(token);if(!session)return;
    session.closed=true;clearTimeout(session.timer);session.calls.clear();this.sessions.delete(token);
  }
  private current(session:Session):boolean {
    const config=this.ctx.fleetConfig?.instances[session.instance];
    let current=false;try{current=session.stillCurrent();}catch{/* a revoked owner is unavailable */}
    return !session.closed && Date.now()<session.expires && process.env.AGEND_WINDOWS_CLI==="1" && current
      && config?.runtime==="windows" && config.native_agent_id===session.agentId && config.backend===session.backend;
  }
  private prune():void { for(const session of this.sessions.values())if(!this.current(session))this.closeToken(session.token); }
  private readOnly(session:Session):boolean {
    return session.sandbox==="read-only" || this.ctx.fleetConfig?.instances[session.instance]?.native_sandbox!=="workspace-write";
  }
  private allowed(session:Session,name:string):boolean {
    const config=this.ctx.fleetConfig?.instances[session.instance];
    return Object.hasOwn(OPS,name) && (!this.readOnly(session) || READ_TOOLS.has(name))
      && mayUseTool(resolveToolSet(config,session.instance),name) && !dashboardRefusalIn(this.ctx.fleetConfig,session.instance,name);
  }
  private canCall(session:Session,name:string,args:Record<string,unknown>):boolean {
    return this.allowed(session,name) && !(name==="task" && this.readOnly(session) && !READ_TASK_ACTIONS.includes(String(args.action)));
  }
  /**
   * A handler may await before it commits a delivery or a task change. Keep the original turn's capability at
   * those commit points, even if another turn for this instance has started in the same Fleet process meanwhile.
   * Bind other methods to the real context so FleetManager's private state and getters keep their owner.
   */
  private dispatcherContext(session:Session,name:string,args:Record<string,unknown>):AgentEndpointContext {
    const assert=():void=>{if(!this.current(session) || !this.canCall(session,name,args))throw Error("Native MCP capability or tool access was revoked before admission");};
    return new Proxy(this.ctx,{
      get:(target,key)=>{
        const value=Reflect.get(target,key,target);
        if(key==="admitDurableDelivery" && typeof value==="function")return (...parameters:unknown[])=>{
          assert();
          const input=parameters[0];
          if(!object(input) || input.sourceInstance!==session.instance)throw Error("Native MCP delivery source does not match its capability");
          return Reflect.apply(value,target,parameters);
        };
        if(key==="handleTaskCrudHttp" && typeof value==="function")return (...parameters:unknown[])=>{
          assert();
          if(parameters[0]!==session.instance || !object(parameters[1]) || !this.canCall(session,"task",parameters[1]))throw Error("Native MCP task access was revoked before admission");
          return Reflect.apply(value,target,parameters);
        };
        return typeof value==="function" ? value.bind(target) : value;
      },
    });
  }
  private menu(session:Session):typeof TOOLS {
    return TOOLS.filter(tool=>this.allowed(session,tool.name)).map(tool=>{
      const readTask=tool.name==="task" && this.readOnly(session);
      const scoped=readTask
        ? {...tool,description:`Read-only task lookup. Allowed actions: ${READ_TASK_ACTIONS.join(", ")}.`,inputSchema:{...tool.inputSchema,properties:{...tool.inputSchema.properties,action:{type:"string",enum:READ_TASK_ACTIONS}}}}
        : tool;
      return {...scoped,annotations:{readOnlyHint:tool.name==="list_instances" || tool.name==="describe_instance" || tool.name==="delivery_status" || readTask}};
    });
  }

  /** Consumes native-token requests even when invalid; they must never fall through to legacy credentials. */
  handleRequest(req:IncomingMessage,res:ServerResponse):boolean {
    const header=req.headers[HEADER];if(header===undefined)return false;
    if(req.method!=="POST" || req.url!=="/agent"){refuse(req,res,405,"Native MCP requires POST /agent");return true;}
    if(gatewayRequestContext(req) || req.headers.origin!==undefined || req.headers.cookie!==undefined || !loopback(req.socket?.remoteAddress)) {
      refuse(req,res,403,"Native MCP is available only to its local CLI child");return true;
    }
    const session=typeof header==="string" && /^[a-f0-9]{64}$/.test(header) ? this.sessions.get(header) : undefined;
    if(!session || !this.current(session)){if(session)this.closeToken(session.token);refuse(req,res,401,"Native MCP capability is invalid or expired");return true;}
    const declared=Number(req.headers["content-length"]);
    if(Number.isFinite(declared) && declared>MAX_BYTES){refuse(req,res,413,"Native MCP request is too large");return true;}
    void this.readRequest(req,res,session);
    return true;
  }
  private async readRequest(req:IncomingMessage,res:ServerResponse,session:Session):Promise<void> {
    try {
      let raw:Buffer;try{raw=await readBoundedWebBody(req,MAX_BYTES);}catch{json(res,413,{error:"Native MCP request could not be read within its limit"});return;}
      if(!this.current(session)){json(res,401,{error:"Native MCP capability is invalid or expired"});return;}
      const body:unknown=JSON.parse(raw.toString("utf8"));
      if(!object(body) || Object.keys(body).some(key=>!["op","method","params","callId"].includes(key)) || body.op!=="native-mcp"
        || !["tools/list","tools/call"].includes(String(body.method)) || !object(body.params)) {json(res,400,{error:"Invalid native MCP operation"});return;}
      if(body.method==="tools/list") {
        if(Object.keys(body.params).length || body.callId!==undefined){json(res,400,{error:"Invalid native MCP tool listing"});return;}
        json(res,200,{tools:this.menu(session)});return;
      }
      const params=body.params,name=params.name;
      if(typeof body.callId!=="string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(body.callId)
        || Object.keys(params).some(key=>!["name","arguments"].includes(key)) || typeof name!=="string" || !object(params.arguments)) {
        json(res,400,{error:"Invalid native MCP tool call"});return;
      }
      if(!this.allowed(session,name)){json(res,403,{error:"This native MCP tool is not available to this instance or access mode"});return;}
      const parsed=OUTBOUND_TOOL_SCHEMAS.get(name)?.safeParse(params.arguments);
      if(!parsed?.success){json(res,200,toolError("Invalid tool arguments"));return;}
      const args=parsed.data as Record<string,unknown>;
      if(name==="task" && this.readOnly(session) && !READ_TASK_ACTIONS.includes(String(args.action))) {
        json(res,403,{error:"Read-only native MCP permits task lookup only"});return;
      }
      const digest=createHash("sha256").update(canonical([name,args])).digest("hex");
      const old=session.calls.get(body.callId);
      if(old && old.digest!==digest){json(res,409,{error:"Native MCP callId belongs to different arguments"});return;}
      if(!old && session.calls.size>=MAX_CALLS){json(res,429,{error:"Native MCP turn call limit reached"});return;}
      const call=old ?? {digest,result:Promise.resolve().then(async()=>{
        if(!this.current(session) || !this.canCall(session,name,args))return toolError("Native MCP capability or tool access was revoked");
        try {
          const value=await dispatchAgentOperation(this.dispatcherContext(session,name,args),session.instance,OPS[name]!,args);
          if(name==="report_result" && !failed(value) && value!==undefined && typeof args.target_instance==="string" && args.target_instance
            && typeof args.correlation_id==="string" && args.correlation_id) {
            const reported=session.reported.get(args.target_instance) ?? new Set<string>();
            reported.add(args.correlation_id);session.reported.set(args.target_instance,reported);
          }
          return result(value);
        } catch(error){return toolError(error instanceof Error ? error.message : "AgEnD tool failed");}
      })};
      if(!old)session.calls.set(body.callId,call);
      const response=await call.result;
      if(!this.current(session)){json(res,401,{error:"Native MCP capability is invalid or expired"});return;}
      if(!this.canCall(session,name,args)) {
        json(res,403,{error:"Native MCP tool access was revoked"});return;
      }
      json(res,200,response);
    } catch(error) {json(res,400,{error:error instanceof SyntaxError ? "Invalid native MCP JSON" : "Invalid native MCP request"});}
  }
}
