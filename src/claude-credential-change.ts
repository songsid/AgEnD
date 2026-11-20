/** A credential change never interrupts work: quiesce and retire all old consumers before commit. */
import { ClaudeCredentialError, type ClaudeCredentialMetadata } from "./claude-credential-vault.js";
export interface ClaudeCredentialConsumer {
 name:string;
 quiesce():Promise<boolean>;
 stop():Promise<void>;
 /** Ownership check prevents an operator stop/replacement being revived by cleanup. */
 current():boolean;
 recover():Promise<void>;
}
export async function changeIdleClaudeCredential(port:{
 consumers:ClaudeCredentialConsumer[];
 assertCurrent():void;
 commit():ClaudeCredentialMetadata;
 releaseStarts():void;
 restart:boolean;
}):Promise<{credential:ClaudeCredentialMetadata;restarted:string[];pending:string[];stopped:string[]}>{
 const held:ClaudeCredentialConsumer[]=[],restarted:string[]=[],pending:string[]=[],stopped:string[]=[];
 let credential:ClaudeCredentialMetadata|undefined,error:unknown;
 try{
  port.assertCurrent();
  for(const consumer of port.consumers){
   if(!await consumer.quiesce())throw new ClaudeCredentialError("in-use");
   held.push(consumer);port.assertCurrent();
  }
  for(const consumer of held){await consumer.stop();stopped.push(consumer.name);port.assertCurrent();}
  credential=port.commit();
 }catch(cause){error=cause;}
 finally{
  // A recovery start must read the committed source, or the unchanged source after a failed write.
  port.releaseStarts();
  for(const consumer of held){
   if(!consumer.current()){pending.push(consumer.name);continue;}
   if(credential&&!port.restart)continue;
   try{await consumer.recover();restarted.push(consumer.name);}catch{pending.push(consumer.name);}
  }
 }
 if(error)throw error;
 return {credential:credential!,restarted,pending,stopped};
}
