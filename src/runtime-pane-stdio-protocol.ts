/** Private coordinator↔Windows relay frames. No shell, executable or arbitrary host path RPC. */
import { validateRuntimePaneRequest, validateRuntimePaneSnapshot, type RuntimePaneRequest, type RuntimePaneSnapshot } from "./runtime-pane-protocol.js";
import { validatePaneMcpBody, type PaneMcpBody } from "./runtime-pane-mcp-protocol.js";
export const PANE_STDIO_LIMIT = 256 * 1024;
export type PaneStdioInput =
 | { type:"init"; scope:string; epoch:string; maxAgents:number }
 | { type:"lease"; epoch:string; online:boolean; maxAgents:number }
 | { type:"request"; epoch:string; id:string; request:RuntimePaneRequest }
 | { type:"mcp.result"; epoch:string; id:string; ok:boolean; result?:unknown };
export type PaneStdioOutput =
 | { type:"hello"; epoch:string; hostBootId:string }
 | { type:"response"; epoch:string; id:string; ok:boolean; result?:unknown }
 | { type:"output"; epoch:string; snapshot:RuntimePaneSnapshot }
 | { type:"mcp.request"; epoch:string; id:string; body:PaneMcpBody };
const uuid=(v:unknown):v is string=>typeof v==="string"&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
const max=(v:unknown):boolean=>Number.isInteger(v)&&(v as number)>=1&&(v as number)<=16;
function frame(value:unknown,keys:string[]):Record<string,unknown>{
 if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key))||Buffer.byteLength(JSON.stringify(value))>PANE_STDIO_LIMIT)throw Error("Invalid local pane frame");
 const v=value as Record<string,unknown>;if(!uuid(v.epoch))throw Error("Invalid local pane epoch");return v;
}
export function paneStdioInput(value:unknown):PaneStdioInput{
 const v=frame(value,["type","epoch","scope","maxAgents","online","id","request","ok","result"]);
 switch(v.type){
 case"init":frame(v,["type","epoch","scope","maxAgents"]);if(typeof v.scope!=="string"||!/^[a-f0-9]{64}$/.test(v.scope)||!max(v.maxAgents))throw Error("Invalid local pane init");break;
 case"lease":frame(v,["type","epoch","online","maxAgents"]);if(typeof v.online!=="boolean"||!max(v.maxAgents))throw Error("Invalid local pane lease");break;
 case"request":frame(v,["type","epoch","id","request"]);if(!uuid(v.id))throw Error("Invalid local pane request");validateRuntimePaneRequest(v.request);break;
 case"mcp.result":frame(v,["type","epoch","id","ok","result"]);if(!uuid(v.id)||typeof v.ok!=="boolean"||!v.ok&&v.result!==undefined)throw Error("Invalid local pane MCP result");break;
 default:throw Error("Unsupported local pane frame");
 }return v as unknown as PaneStdioInput;
}
export function paneStdioOutput(value:unknown):PaneStdioOutput{
 const v=frame(value,["type","epoch","hostBootId","id","ok","result","snapshot","body"]);
 switch(v.type){
 case"hello":frame(v,["type","epoch","hostBootId"]);if(!uuid(v.hostBootId))throw Error("Invalid local pane host");break;
 case"response":frame(v,["type","epoch","id","ok","result"]);if(!uuid(v.id)||typeof v.ok!=="boolean"||!v.ok&&v.result!==undefined)throw Error("Invalid local pane response");break;
 case"output":frame(v,["type","epoch","snapshot"]);validateRuntimePaneSnapshot(v.snapshot);break;
 case"mcp.request":frame(v,["type","epoch","id","body"]);if(!uuid(v.id))throw Error("Invalid local pane MCP request");validatePaneMcpBody(v.body);break;
 default:throw Error("Unsupported local pane frame");
 }return v as unknown as PaneStdioOutput;
}
/** Incremental UTF-8 and byte bounds, including a newline-free malicious frame. */
export class PaneStdioFramer{
 private decoder=new TextDecoder("utf-8",{fatal:true});private partial="";
 feed(bytes:Uint8Array,receive:(value:unknown)=>void):void{
  if(bytes.length>PANE_STDIO_LIMIT*4)throw Error("Local pane input burst exceeded limit");
  this.partial+=this.decoder.decode(bytes,{stream:true});
  for(;;){const at=this.partial.indexOf("\n");if(at<0)break;const line=this.partial.slice(0,at);this.partial=this.partial.slice(at+1);if(Buffer.byteLength(line)>PANE_STDIO_LIMIT)throw Error("Local pane frame exceeded limit");if(!line)throw Error("Empty local pane frame");receive(JSON.parse(line));}
  if(Buffer.byteLength(this.partial)>PANE_STDIO_LIMIT)throw Error("Local pane partial frame exceeded limit");
 }
}
