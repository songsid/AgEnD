/** Private Hub Runtime receiver. No ordinary Fleet pairing, panes, tools, account management or updater is composed. */
import type {IncomingMessage,ServerResponse} from "node:http";
import type {Duplex} from "node:stream";
import {RuntimeCoordinator} from "../../runtime-coordinator.js";
import {RuntimeInstallService,type RuntimeInstallOptions} from "../../runtime-install.js";
import {RUNTIME_CONNECT_PATH,RUNTIME_ENROLL_PATH,RUNTIME_ENROLL_HELLO_PATH,RUNTIME_ROTATE_PATH} from "../../runtime-protocol.js";
import {gatewayRequestContext} from "../../web-request-context.js";
import {ensurePrivateDirectory} from "../private-files.js";
interface Options {
  home:string;current():boolean;enabled():boolean;now?():number;
  log(level:"info"|"warn",message:string,meta?:Record<string,unknown>):void;
  installer?:Pick<RuntimeInstallOptions,"bundle"|"template">;
}
export class HubPersonalRuntimeHost {
  readonly runtime:RuntimeCoordinator;
  readonly install:RuntimeInstallService;
  private closed=false;
  constructor(private readonly options:Options){
    this.runtime=new RuntimeCoordinator(ensurePrivateDirectory(options.home,"hub/personal-runtime"),{now:options.now,
      audit:entry=>options.log("info","Personal Runtime enrollment",{event:entry.event,enrollmentId:entry.enrollmentId,machineId:entry.machineId}),
      warn:(fields,message)=>options.log("warn",message,fields)});
    this.install=new RuntimeInstallService({...options.installer,enabled:()=>this.active(),personal:true});
  }
  private active():boolean {try{return !this.closed&&this.options.current()&&this.options.enabled();}catch{return false;}}
  handle(req:IncomingMessage,res:ServerResponse,url:URL):boolean {
    if(!url.pathname.startsWith("/runtime/"))return false;
    if(!this.active()||gatewayRequestContext(req))return this.absent(res);
    if(this.install.handle(req,res,url))return true;
    if(![RUNTIME_ENROLL_HELLO_PATH,RUNTIME_ENROLL_PATH,RUNTIME_ROTATE_PATH].includes(url.pathname))return this.absent(res);
    return this.runtime.handlePublicRequest(req,res,url);
  }
  private absent(res:ServerResponse):true {res.writeHead(404,{"Content-Type":"application/json","Cache-Control":"no-store"}).end('{"code":"not-found"}');return true;}
  upgrade(req:IncomingMessage,socket:Duplex,head:Buffer):void {
    let path:string;try{path=new URL(req.url??"","https://localhost").pathname;}catch{socket.destroy();return;}
    if(!this.active()||gatewayRequestContext(req)||path!==RUNTIME_CONNECT_PATH||!this.runtime.handleUpgrade(req,socket,head))socket.destroy();
  }
  close():void {if(this.closed)return;this.closed=true;this.runtime.close();}
}
