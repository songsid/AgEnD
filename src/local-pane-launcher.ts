/** Stage only the verified shipped code bundle. Never enumerate a provider home or copy login material. */
import {createHash} from "node:crypto";
import {mkdir,mkdtemp,writeFile,rm} from "node:fs/promises";
import {dirname,join,win32} from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";
import {execFile,spawn} from "./child-process.js";
import {createRuntimeBundle} from "./runtime-bundle.js";
import {admitLocalWindowsCli} from "./windows-cli.js";
import {nativeCliEnvironment,validWindowsDirectory} from "./windows-cli-worker.js";
const exec=promisify(execFile);
export const localPaneScope=(home:string):string=>createHash("sha256").update(home).digest("hex");
export async function launchLocalPaneRelay(home:string,admit:()=>void=admitLocalWindowsCli){
 admit();if(process.platform!=="linux"&&process.platform!=="win32")throw Error("Local Windows panes require Windows or WSL");
 const code=dirname(fileURLToPath(import.meta.url)),powershell=process.platform==="win32"?join(process.env.SystemRoot||"C:\\Windows","System32","WindowsPowerShell","v1.0","powershell.exe"):"/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
 const convert=async(path:string,direction:"-w"|"-u")=>process.platform==="win32"?path:String((await exec("wslpath",[direction,path],{timeout:5000,maxBuffer:8192,encoding:"utf8"})).stdout).trim();
 await mkdir(home,{recursive:true,mode:0o700});const temporary=await mkdtemp(join(home,"pane-code-"));
 try{
  const bundle=createRuntimeBundle(),archive=join(temporary,"runtime.zip");await writeFile(archive,bundle.bytes,{mode:0o600});
  const [script,zip]=await Promise.all([convert(join(code,"local-pane-stage.ps1"),"-w"),convert(archive,"-w")]);admit();
  const staged=await exec(powershell,["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",script,"-Archive",zip,"-Sha256",bundle.sha256,"-Scope",localPaneScope(home)],{env:nativeCliEnvironment(),timeout:120_000,maxBuffer:8192,encoding:"utf8",windowsHide:true});
  const value=JSON.parse(String(staged.stdout).trim());
  if(!value||Object.keys(value).sort().join(",")!=="node,relay"||!validWindowsDirectory(value.node)||!validWindowsDirectory(value.relay)||win32.basename(value.node).toLowerCase()!=="node.exe"||win32.basename(value.relay)!=="runtime-pane-stdio.js")throw Error("Staged Windows pane code could not be verified");
  const node=await convert(value.node,"-u");admit();return spawn(node,[value.relay],{env:nativeCliEnvironment(),shell:false,windowsHide:true,stdio:["pipe","pipe","pipe"]});
 }finally{await rm(temporary,{recursive:true,force:true});}
}
