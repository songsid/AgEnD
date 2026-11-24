/** Internal helper/launcher process. Never import the CLI logger or dotenv loader here. */
import { spawn } from "./child-process.js";
import { ClaudeCredentialVault } from "./claude-credential-vault.js";
import { UnsupportedCliError } from "./backend/types.js";
import { currentManagedClaude, managedClaudeAuthInputs, managedClaudeEnv, probeManagedClaudeSource, readManagedClaudeSpec, writeClaudeCredentialPipe } from "./claude-credential-launch.js";
async function run():Promise<void>{
 const [mode,path,...extra]=process.argv.slice(2);if(!path||extra.length||!["helper","launch"].includes(mode))throw Error();
 const spec=readManagedClaudeSpec(path),vault=new ClaudeCredentialVault(spec.binding.home);
 let value:Buffer|undefined;
 try{
  if(spec.binding.kind!=="subscription"){
   const credential=vault.credential(spec.binding.profile,spec.binding.id,spec.binding.revision);value=credential.value;
   if(credential.kind!==spec.binding.kind)throw Error();
  }else if(!currentManagedClaude(spec.binding))throw Error();
  if(mode==="helper"){
   if(spec.binding.kind!=="api-key"||!value)throw Error();
   managedClaudeAuthInputs(spec);
   // This stdout is Claude's private credential pipe, never the Fleet/chat/log output.
   await writeClaudeCredentialPipe(value,process.stdout);value=undefined;return;
  }
  const before=managedClaudeAuthInputs(spec),env=managedClaudeEnv(process.env,spec.env,spec.binding.kind==="setup-token"?value!.toString("utf8"):undefined);
  if(!probeManagedClaudeSource(spec,env)||!currentManagedClaude(spec.binding)||managedClaudeAuthInputs(spec)!==before)throw Error();
  value?.fill(0);value=undefined;vault.close();
  const execve=(process as NodeJS.Process&{execve?:(file:string,args:string[],env:Record<string,string>)=>never}).execve;
  process.chdir(spec.cwd);
  if(execve){execve(spec.binary,[spec.binary,...spec.args],Object.fromEntries(Object.entries(env).filter((x):x is [string,string]=>typeof x[1]==="string")));}
  else{
   const child=spawn(spec.binary,spec.args,{cwd:spec.cwd,env,stdio:"inherit"});
   for(const signal of ["SIGTERM","SIGINT","SIGHUP"] as const)process.on(signal,()=>child.kill(signal));
   await new Promise<void>((resolve,reject)=>{child.once("error",()=>reject(Error()));child.once("exit",code=>{process.exitCode=code??1;resolve();});});
  }
 }finally{value?.fill(0);try{vault.close();}catch{}}
}
// M-3558: a refusal that names its cause (a remote-settings key) says so; anything else stays the plain line.
void run().catch((e:unknown)=>{process.stderr.write((e instanceof UnsupportedCliError&&/remote-settings/.test(e.message)?e.message:"Managed Claude credential unavailable or source changed; open Accounts on the local dashboard.")+"\n");process.exitCode=1;});
