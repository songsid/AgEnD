/** Adds local guidance to a confirmed platform result; never changes its destination or treats an error as success. */
export function withHubRoomReplyWarning(result:unknown,warning:string|undefined|(()=>string|undefined),error?:string):unknown{
 if(error||result==null||typeof result==="object"&&"error" in result)return result;
 let note:string|undefined;try{note=typeof warning==="function"?warning():warning;}catch{return result;}
 if(!note)return result;
 return typeof result==="string"?`${result}\n\n${note}`:typeof result==="object"?{...result,hub_warning:note}:result;
}
