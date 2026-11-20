/** Secret-output variant of the existing dedicated Connect-account transport. */
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import type { StructuredSignInTransport } from "./structured-signin.js";
import { structuredSignInPrompt } from "./structured-signin.js";
import { TmuxTerminalBackend, shellQuote, segmentInput, type TerminalBackend } from "./web-terminal.js";
export interface SetupTokenTransport extends StructuredSignInTransport { takeToken(): string | null }
export function createClaudeSetupTokenTransport(options: { native?: TerminalBackend; env?: NodeJS.ProcessEnv } = {}): SetupTokenTransport {
 const native=options.native??new TmuxTerminalBackend(),socket="agend-term-token-"+randomBytes(16).toString("hex"),marker="agend-end-"+randomBytes(16).toString("hex");
 let directory:string|null=null,raw="",token:string|null=null,code:number|undefined,closed=false,started=false,touched=false,failed=false;
 const erase=()=>{raw="";token=null;};
 return {
  async start(_spec,signal){
   if(started||closed||signal.aborted)throw Error("signin_cancelled");started=true;
   directory=mkdtempSync(join(tmpdir(),"agend-token-"));
   for(const folder of ["home","config","cache","tmp"])mkdirSync(join(directory,folder),{mode:0o700});
   const source=options.env??process.env,env:Record<string,string>={HOME:join(directory,"home"),CLAUDE_CONFIG_DIR:join(directory,"config"),XDG_CONFIG_HOME:join(directory,"config"),XDG_CACHE_HOME:join(directory,"cache"),TMPDIR:join(directory,"tmp"),TERM:"xterm-256color",BROWSER:"false",EDITOR:"false",VISUAL:"false"};
   for(const key of ["PATH","LANG","LC_ALL"])if(source[key]&&!/[\0\r\n]/.test(source[key]!))env[key]=source[key]!;
   if(!env.PATH)throw Error("signin_environment_unavailable");
   // A private completion marker in the SAME output stream proves the final
   // token bytes were read; pane death alone cannot race ahead of FIFO output.
   const command="claude setup-token; result=$?; printf '\\n"+marker+":%s\\n' \"$result\"; exit \"$result\"";
   touched=true;
   await native.start({socket,cwd:directory,cols:240,rows:48,privateOutput:true,signal,command:"exec env -i "+Object.entries(env).map(([k,v])=>shellQuote(k+"="+v)).join(" ")+" sh -c "+shellQuote(command),onOutput:chunk=>{
    if(closed||failed||code!==undefined)return;
    if(Buffer.byteLength(raw)+chunk.length>64*1024){failed=true;erase();return;}
    raw+=chunk.toString("utf8");
    const plain=stripVTControlCharacters(raw).replace(/\r/g,"");
    const end=new RegExp("(?:^|\\n)"+marker+":([0-9]{1,3})\\n").exec(plain);if(!end)return;
    code=Number(end[1]);
    if(code===0){const values=[...new Set([...plain.slice(0,end.index).matchAll(/\bsk-ant-oat01-[A-Za-z0-9_-]{32,4096}(?=[\s"'`]|$)/g)].map(m=>m[0]))];if(values.length===1)token=values[0]!;}
    raw="";
   }});
   if(signal.aborted||closed)throw Error("signin_cancelled");
  },
  async capture(){
   if(closed||failed)throw Error("signin_transport_unavailable");if(code!==undefined)return "";
   const prompt=structuredSignInPrompt("claude-code",stripVTControlCharacters(raw));
   const url=prompt.phase==="authorization"||prompt.phase==="code"?prompt.url:null;
   if(url?.includes("sk-ant-"))throw Error("signin_unsupported_prompt");
   return [url??"",prompt.phase==="code"?"Paste code here if prompted >":""].filter(Boolean).join("\n");
  },
  async status(){if(closed||!started||failed)throw Error("signin_status_unknown");const state=await native.paneStatus(socket);if(!state)throw Error("signin_status_unknown");return {alive:state.alive||code===undefined,...(code!==undefined?{exitCode:code}:{})};},
  async write(input,signal){for(const run of segmentInput(Buffer.from(input,"utf8"))){if(closed||signal.aborted||code!==undefined)throw Error("signin_cancelled");await native.sendInput(socket,run.bytes);}},
  takeToken(){const result=code===0&&!failed?token:null;token=null;return result;},
  async close(){closed=true;erase();if(touched)await native.kill(socket);if(directory){rmSync(directory,{recursive:true,force:true});directory=null;}},
 };
}
