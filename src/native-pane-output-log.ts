/** Diagnostic output only. This stream is never delivery, completion or process-exit evidence. */
import{constants}from"node:fs";import{open,lstat,readFile,realpath,rename,unlink}from"node:fs/promises";import{dirname,resolve}from"node:path";
import{randomUUID}from"node:crypto";import{rotateLogIfNeededAsync}from"./logger.js";import{validatePaneOutputBatch,type PaneOutputBatch}from"./runtime-pane-output.js";
export class NativePaneOutputLog{
 private offset=0;private stopped=false;private inFlight=false;private timer:ReturnType<typeof setInterval>|undefined;
 constructor(private path:string,private owner:string,private current:()=>boolean,private read:(offset:number)=>Promise<PaneOutputBatch>){}
 async start():Promise<void>{
  if(await realpath(dirname(this.path))!==resolve(dirname(this.path)))throw Error("Native output log directory is not canonical");
  try{const stat=await lstat(this.path+".native-cursor");if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4096||process.getuid&&(stat.uid!==process.getuid()||!!(stat.mode&0o077)))throw Error("Unsafe native output cursor");const value=JSON.parse(await readFile(this.path+".native-cursor","utf8"));if(Object.keys(value).some(key=>!["version","owner","offset"].includes(key))||value.version!==1||!Number.isSafeInteger(value.offset)||value.offset<0)throw Error("Invalid native output cursor");if(value.owner===this.owner)this.offset=value.offset;}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  await this.poll();if(!this.stopped){this.timer=setInterval(()=>{void this.poll().catch(()=>this.stop());},500);this.timer.unref();}
 }
 stop():void{this.stopped=true;clearInterval(this.timer);}
 private async poll():Promise<void>{
  if(this.stopped||this.inFlight||!this.current())return;this.inFlight=true;
  try{
   const batch=validatePaneOutputBatch(await this.read(this.offset),this.offset);if(this.stopped||!this.current())return;
   if(batch.next===this.offset&&!batch.gap)return;
   try{const old=await lstat(this.path);if(!old.isFile()||old.isSymbolicLink()||process.getuid&&(old.uid!==process.getuid()||!!(old.mode&0o077)))throw Error("Unsafe native output log");}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
   await rotateLogIfNeededAsync(this.path);if(this.stopped||!this.current())return;
   const file=await open(this.path,constants.O_WRONLY|constants.O_APPEND|constants.O_CREAT|(constants.O_NOFOLLOW??0),0o600);
   try{const stat=await file.stat();if(!stat.isFile()||process.getuid&&(stat.uid!==process.getuid()||!!(stat.mode&0o077)))throw Error("Unsafe native output log");if(this.stopped||!this.current())return;
    if(batch.gap)await file.appendFile("\n[AgEnD: native output exceeded the retained buffer]\n");await file.appendFile(Buffer.from(batch.data,"base64"));await file.sync();
   }finally{await file.close();}
   if(this.stopped||!this.current())return;
   const cursor=this.path+".native-cursor",temporary=cursor+"."+randomUUID();
   try{const fd=await open(temporary,"wx",0o600);try{await fd.writeFile(JSON.stringify({version:1,owner:this.owner,offset:batch.next}));await fd.sync();}finally{await fd.close();}await rename(temporary,cursor);}finally{await unlink(temporary).catch(()=>{});}
   this.offset=batch.next;
  }finally{this.inFlight=false;}
 }
}
