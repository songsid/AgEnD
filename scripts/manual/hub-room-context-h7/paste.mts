/** Owned raw-mode mock only. No Fleet/Daemon, vendor CLI, account, network or default tmux socket. */
import {execFileSync} from "node:child_process";
import {createHash,randomUUID} from "node:crypto";
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from "node:fs";
import {join,resolve} from "node:path";
import {createRequire} from "node:module";
import {runInNewContext} from "node:vm";
const repo=process.cwd(),out=resolve(process.argv[2]??"docs/evidence/hub-room-context-h7");mkdirSync(out,{recursive:true});
mkdirSync(join(repo,".artifacts"),{recursive:true});
const scratch=mkdtempSync(join(repo,".artifacts","h7-paste-")),socket=`agend-test-h7-${randomUUID().slice(0,12)}`,session="mock";
process.env.AGEND_HOME=join(scratch,"home");mkdirSync(process.env.AGEND_HOME,{recursive:true});
const {TmuxManager}=await import(join(repo,"src/tmux-manager.ts")),{tmuxBinary}=await import(join(repo,"src/tmux-binary.ts"));
const {formatRoomAskPrompt}=await import(join(repo,"src/hub/member/room-ask.ts"));
const require=createRequire(import.meta.url),ts=require("typescript");
const base="13abcddd878d801da8bb7c1cf352a3b84ac50929",source=execFileSync("git",["show",`${base}:src/hub/member/room-ask.ts`],{encoding:"utf8"});
const old=source.slice(source.indexOf("export function formatRoomAskPrompt("),source.indexOf("export function agentPresence("));
const js=ts.transpileModule(old,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,exports={};runInNewContext(js,{exports});
const legacy=(exports as {formatRoomAskPrompt:typeof formatRoomAskPrompt}).formatRoomAskPrompt;
const hash=(v:string|Buffer)=>createHash("sha256").update(v).digest("hex"),quote=(s:string)=>"'"+s.replace(/'/g,"'\\''")+"'";
const reader=join(scratch,"reader.py");writeFileSync(reader,`import os,sys,tty\ntty.setraw(0)\nopen(sys.argv[2],"w").write("raw-ready")\nremaining=int(sys.argv[3])\nwith open(sys.argv[1],"wb") as out:\n while remaining:\n  data=os.read(0,min(65536,remaining))\n  if not data: break\n  out.write(data);out.flush();remaining-=len(data)\n`);
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const wait=async(test:()=>boolean,label:string)=>{const end=Date.now()+15000;while(!test()){if(Date.now()>end)throw Error(label);await sleep(25);}};
TmuxManager.setSocketName(socket);const cases:unknown[]=[];
try{
 await TmuxManager.ensureSession(session);
 const ask={messageId:randomUUID(),roomId:randomUUID(),exposureId:randomUUID(),roomName:"Fixture room",asker:{name:"A colleague"},text:"Summarize the newest messages.",context:Array.from({length:31},(_,i)=>({author:"A colleague",text:`row-${i}:`+"x".repeat(2040),at:i+1,...(i===0?{repliedTo:true as const}:{})}))};
 for(const locale of ["en","zh-TW"] as const)for(const mode of ["before","after"] as const){
  const prompt=mode==="before"?legacy(ask,"hub-room-owned",locale):formatRoomAskPrompt(ask,"hub-room-owned",locale);
  if(mode==="before"&&prompt!==formatRoomAskPrompt(ask,"hub-room-owned",locale,{maxContextBytes:Number.MAX_SAFE_INTEGER}))throw Error("Legacy comparison drift");
  const tag=`${mode}-${locale}`,payload=join(scratch,tag+".bin"),ready=join(scratch,tag+".ready"),expected=Buffer.byteLength(prompt),tm=new TmuxManager(session,"");
  try{
   await tm.createWindow(`python3 ${quote(reader)} ${quote(payload)} ${quote(ready)} ${expected}`,scratch,tag);await wait(()=>existsSync(ready),"Mock never entered raw mode");
   const accepted=await tm.pasteBuffer(prompt,{timeoutMs:5000});if(!accepted)throw Error("Paste refused");await wait(()=>existsSync(payload)&&readFileSync(payload).length===expected,"Mock byte count incomplete");
   const received=readFileSync(payload),data=JSON.parse(prompt.split("```json\n")[1]!.split("\n```")[0]!);
   const logicalHashEqual=hash(received.toString("utf8").replace(/\r/g,"\n"))===hash(prompt);
   const transportHashEqual=hash(received)===hash(prompt.replace(/\n/g,"\r"));if(!logicalHashEqual||!transportHashEqual)throw Error("Mock payload hash mismatch after expected tmux newline translation");
   cases.push({tag,tmuxAccepted:accepted,sentBytes:expected,receivedBytes:received.length,rawHashEqual:hash(received)===hash(prompt),logicalHashEqual,transportHashEqual,historyBytes:Buffer.byteLength(JSON.stringify({context:data.context},null,2)),rows:data.context.length,questionExact:data.question.text===ask.text,over16000:expected>16000});
   writeFileSync(join(out,tag+".prompt.txt"),prompt);
  }finally{await tm.killWindow().catch(()=>{});}
 }
 const sourceFiles=["src/hub/member/room-ask.ts","src/hub/member/room-context-budget.ts","src/hub/compose/member.ts","src/hub/runtime.ts","src/fleet-manager.ts"];
 writeFileSync(join(out,"paste.json"),JSON.stringify({baseline:base,head:execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim(),dirty:execFileSync("git",["status","--porcelain"],{encoding:"utf8"}).trim().length>0,tmuxVersion:execFileSync(tmuxBinary(),["-V"],{encoding:"utf8"}).trim(),mock:"Python raw-mode byte receiver; tmux LF-to-CR translation is normalized before logical comparison; no vendor process",socketScope:"per-run owned private socket only",sourceHashes:Object.fromEntries(sourceFiles.map(f=>[f,hash(readFileSync(join(repo,f)))])),cases,note:"Successful tmux/raw mock transfer is not proof of every vendor composer. No historical paste failure is claimed; the cap prevents the oversized history transfer."},null,2)+"\n");
 console.log(JSON.stringify(cases));
}finally{
 try{execFileSync(tmuxBinary(),["-L",socket,"kill-server"],{stdio:"ignore"});}catch{/* Owned socket may never have started. */}finally{TmuxManager.setSocketName(null);rmSync(scratch,{recursive:true,force:true});}
}
