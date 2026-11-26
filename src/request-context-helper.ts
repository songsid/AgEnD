/** Launch admission only. It does not identify a human, a turn, an approval or a completed side effect. */
import { randomBytes, timingSafeEqual } from "node:crypto";
interface HelperSocket {destroyed?:boolean;once?:(event:"close",listener:()=>void)=>unknown}
const HELPER_FRAMES=new Set(["mcp_ready","tool_call","pong"]);
export class RequestContextHelperAdmission {
 private token:string|null=null;
 private confirmed=false;
 private readonly sockets=new WeakMap<object,string>();
 private readonly connected=new Set<HelperSocket>();
 private serial=0;
 get revision():number{return this.serial;}
 ready():boolean{return this.confirmed&&[...this.connected].some(socket=>!socket.destroyed&&this.sockets.get(socket)===this.token);}
 begin():string {this.token=randomBytes(32).toString("hex");this.confirmed=false;this.connected.clear();this.serial++;return this.token;}
 environment():string|null{return this.token;}
 confirm(token:string):void {if(!this.equal(token))throw Error("Request helper launch changed");this.confirmed=true;this.serial++;}
 revoke():void {this.token=null;this.confirmed=false;this.connected.clear();this.serial++;}
 private equal(value:unknown):boolean{return typeof value==="string"&&/^[a-f0-9]{64}$/.test(value)&&!!this.token&&timingSafeEqual(Buffer.from(value,"hex"),Buffer.from(this.token,"hex"));}
 admit(raw:unknown,socket:HelperSocket):boolean {
  if(!raw||typeof raw!=="object"||Array.isArray(raw))return false;
  const message=raw as Record<string,unknown>,type=message.type;
  if(type==="mcp_ready"){
   const offered=message.launchToken;delete message.launchToken; // Never relay or log the launch bearer.
   if(!this.confirmed||!this.equal(offered))return false;
   this.sockets.set(socket,this.token!);
   if(!this.connected.has(socket)){this.connected.add(socket);this.serial++;socket.once?.("close",()=>{if(this.connected.delete(socket))this.serial++;});}
   return true;
  }
  if(this.sockets.has(socket)||HELPER_FRAMES.has(String(type)))return this.confirmed&&this.sockets.get(socket)===this.token;
  return true; // The Fleet's own IPC control client is not an MCP helper.
 }
}
