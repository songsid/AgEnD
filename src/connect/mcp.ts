/** Shared 4a/4c SDK shell. Static catalog; the caller-bound service owns validation and every effect. */
import {Server} from "@modelcontextprotocol/sdk/server/index.js";
import {CallToolRequestSchema,ListToolsRequestSchema,type Tool,type CallToolResult} from "@modelcontextprotocol/sdk/types.js";

export function staticPersonMcp(options:{name:string;instructions:string;tools:readonly Tool[];call:(name:string,input:unknown)=>Promise<CallToolResult>}):Server {
  const server=new Server({name:options.name,version:"1"},{capabilities:{tools:{}},instructions:options.instructions});
  server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[...options.tools]}));
  server.setRequestHandler(CallToolRequestSchema,request=>options.call(request.params.name,request.params.arguments??{}));
  return server;
}
