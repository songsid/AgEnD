import {REQUEST_CONTEXT_DRAIN_FAMILIES} from "./request-context-drain.js";
export const REQUEST_CONTEXT_BLOCKER_FAMILIES=[...REQUEST_CONTEXT_DRAIN_FAMILIES,"human-input","unknown"] as const;
export type RequestContextBlockerFamily=typeof REQUEST_CONTEXT_BLOCKER_FAMILIES[number];
/** F owns these references. Body text and tool arguments never enter this projection. */
export function projectRequestContextWork(blockers:readonly string[]):{families:RequestContextBlockerFamily[];unknownEnd:boolean;stoppable:boolean} {
 const families=new Set<RequestContextBlockerFamily>();let unknownEnd=false,stoppable=true;
 for(const blocker of blockers){
  if(blocker==="recovery-pointer")continue;
  if(blocker==="pending-root-fence"){families.add("registered-work");continue;}
  if(/^(?:delivery|held|return):/.test(blocker)){stoppable=false;continue;}
  if(blocker.startsWith("human-input:")){families.add("human-input");continue;}
  try{
   const boundary=blocker.indexOf("]:");if(boundary<0)throw Error("Not a participant reference");
   const id=JSON.parse(blocker.slice(0,boundary+1));
   if(!Array.isArray(id)||id.length!==2||!REQUEST_CONTEXT_DRAIN_FAMILIES.includes(id[0])||typeof id[1]!=="string")throw Error("Unknown participant");
   families.add(id[0]);if(blocker.slice(boundary+2).includes("unknown-end:"))unknownEnd=true;
  }catch{families.add("unknown");stoppable=false;}
 }
 return {families:REQUEST_CONTEXT_BLOCKER_FAMILIES.filter(family=>families.has(family)),unknownEnd,stoppable:stoppable&&families.size>0};
}
