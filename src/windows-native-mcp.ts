/** Native Windows stdio MCP adapter. Built-ins only; credentials live in a per-turn private file, never argv/env. */
import { createHmac } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateNativeMcpConnection, type NativeMcpConnection } from "./windows-cli-providers.js";

type ObjectValue = Record<string,unknown>;
const object = (v:unknown): v is ObjectValue => !!v && typeof v === "object" && !Array.isArray(v);
const MAX_LINE = 80_000, MAX_RESPONSE = 1024 * 1024;
export type NativeMcpRequest = { op:"native-mcp"; method:"tools/list"|"tools/call"; params:Record<string,unknown>; callId?:string };
export type NativeMcpTransport = (body:NativeMcpRequest)=>Promise<unknown>;

export function readNativeMcpConnection(path:string): NativeMcpConnection {
  const stat=lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32_000) throw new Error("Invalid native MCP connection file");
  return validateNativeMcpConnection(JSON.parse(readFileSync(path,"utf8")));
}

/** HTTP is restricted to the coordinator's exact loopback endpoint. No redirect or cookie handling. */
export function nativeMcpHttp(connection:NativeMcpConnection,body:NativeMcpRequest):Promise<unknown> {
  const checked=validateNativeMcpConnection(connection);
  return new Promise((accept,reject)=>{
    const payload=JSON.stringify(body);
    if(Buffer.byteLength(payload)>MAX_LINE){reject(new Error("AgEnD tool request exceeded its limit"));return;}
    const req=request(checked.endpoint,{method:"POST",headers:{"Content-Type":"application/json","Content-Length":Buffer.byteLength(payload),"X-Agend-Native-Token":checked.token}},res=>{
      let bytes=0,text="";
      res.setEncoding("utf8");
      res.on("data",(part:string)=>{bytes+=Buffer.byteLength(part);if(bytes>MAX_RESPONSE){req.destroy(new Error("AgEnD tool response exceeded its limit"));return;}text+=part;});
      res.on("error",()=>reject(new Error("AgEnD tool connection ended")));
      res.on("end",()=>{
        if((res.statusCode ?? 500)<200 || (res.statusCode ?? 500)>=300){reject(new Error("AgEnD tool request was refused or its turn expired"));return;}
        try{accept(JSON.parse(text));}catch{reject(new Error("Invalid AgEnD tool response"));}
      });
    });
    req.setTimeout(90_000,()=>req.destroy(new Error("AgEnD tool request timed out")));
    req.on("error",()=>reject(new Error("AgEnD tool connection failed")));
    req.end(payload);
  });
}

export function nativeMcpCallId(token: string, id: string | number, clientSessionId?: string): string {
  return createHmac("sha256", token).update(JSON.stringify(clientSessionId ? [clientSessionId, id] : id)).digest("hex");
}

/** Testable protocol surface. Never executes tools for notifications or unrecognized method names. */
export async function nativeMcpRpc(raw:unknown,connection:NativeMcpConnection,transport:NativeMcpTransport=body=>nativeMcpHttp(connection,body), context?: { clientSessionId: string; instructions?: string }):Promise<ObjectValue|null> {
  const id=object(raw) && (typeof raw.id === "string" && raw.id.length<=128 || typeof raw.id === "number" && Number.isSafeInteger(raw.id)) ? raw.id : null;
  const error=(code:number,message:string):ObjectValue=>({jsonrpc:"2.0",id,error:{code,message}});
  if(!object(raw) || raw.jsonrpc!=="2.0" || typeof raw.method!=="string")return error(-32600,"Invalid request");
  if(raw.id===undefined)return null;
  if(id===null)return error(-32600,"Invalid request id");
  try{
    let result:unknown;
    if(raw.method==="initialize") {
      const offered=object(raw.params) ? raw.params.protocolVersion : undefined;
      result={protocolVersion:["2024-11-05","2025-03-26","2025-06-18"].includes(String(offered))?offered:"2024-11-05",capabilities:{tools:{}},serverInfo:{name:"agend-native",version:"1.0.0"},instructions:context?.instructions ?? "AgEnD tools are limited to this agent, execution turn and configured permissions."};
    }else if(raw.method==="ping")result={};
    else if(raw.method==="tools/list"){
      const listed=await transport({op:"native-mcp",method:"tools/list",params:{}});
      if(!object(listed)||!Array.isArray(listed.tools))throw new Error("Invalid AgEnD tool list");
      result={tools:listed.tools.filter(tool=>object(tool)&&typeof tool.name==="string"&&connection.tools.includes(tool.name))};
    }else if(raw.method==="tools/call"){
      if(!object(raw.params)||typeof raw.params.name!=="string"||!connection.tools.includes(raw.params.name)||raw.params.arguments!==undefined&&!object(raw.params.arguments))return error(-32602,"Tool is unavailable for this execution");
      const callId=nativeMcpCallId(connection.token,id,context?.clientSessionId);
      result=await transport({op:"native-mcp",method:"tools/call",callId,params:{name:raw.params.name,arguments:raw.params.arguments ?? {}}});
      if(!object(result)||!Array.isArray(result.content))throw new Error("Invalid AgEnD tool result");
    }else return error(-32601,"Method not found");
    return {jsonrpc:"2.0",id,result};
  }catch{return error(-32000,"AgEnD tool request failed or this execution is no longer active");}
}

function main():void {
  if(process.argv.length!==4 || process.argv[2]!=="--connection-file")throw new Error("Expected a native MCP connection file");
  const connection=readNativeMcpConnection(process.argv[3]);
  let buffer="",failed=false;
  const send=(value:unknown):void=>{process.stdout.write(JSON.stringify(value)+"\n");};
  process.stdin.setEncoding("utf8").on("data",(part:string)=>{
    if(failed)return;
    buffer+=part;
    let at:number;
    while((at=buffer.indexOf("\n"))>=0){
      const line=buffer.slice(0,at).trim();buffer=buffer.slice(at+1);if(!line)continue;
      if(Buffer.byteLength(line)>MAX_LINE){failed=true;process.exitCode=1;process.stdin.destroy();return;}
      let value:unknown;try{value=JSON.parse(line);}catch{send({jsonrpc:"2.0",id:null,error:{code:-32700,message:"Parse error"}});continue;}
      void nativeMcpRpc(value,connection).then(response=>{if(response)send(response);});
    }
    if(Buffer.byteLength(buffer)>MAX_LINE){failed=true;process.exitCode=1;process.stdin.destroy();}
  });
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{main();}catch{process.stderr.write("Native AgEnD MCP setup failed\n");process.exitCode=1;}
}
