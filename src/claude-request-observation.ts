/** Native request metadata only. Rendered pane/model text never proves credential validity. */
import { isClaudeMainRecord } from "./claude-model-observation.js";
export interface ClaudeRequestObservation {
 id: string; sessionId: string; at: number; outcome: "success" | "auth-error" | "unknown";
}
const identifier=(v:unknown):v is string=>typeof v==="string"&&/^[\w.-]{1,200}$/.test(v);
export function parseClaudeRequestObservation(entry:any):ClaudeRequestObservation|null {
 if(!entry||["isApiErrorMessage","isSidechain","isMeta"].some(key=>entry[key]!==undefined&&typeof entry[key]!=="boolean")||entry.type!=="assistant"||!isClaudeMainRecord({...entry,isApiErrorMessage:false})||entry.message?.role!=="assistant")return null;
 const sessionId=entry.sessionId??entry.session_id,at=typeof entry.timestamp==="string"?Date.parse(entry.timestamp):NaN;
 if(!identifier(sessionId)||(entry.sessionId&&entry.session_id&&entry.sessionId!==entry.session_id)||!Number.isSafeInteger(at))return null;
 if(entry.isApiErrorMessage===true){
  if(!identifier(entry.uuid))return null;
  const text=typeof entry.message.content==="string"?entry.message.content.slice(0,512):Array.isArray(entry.message.content)?entry.message.content.filter((b:any)=>b?.type==="text"&&typeof b.text==="string").slice(0,4).map((b:any)=>b.text.slice(0,128)).join(""):"";
  const status=Number.isInteger(entry.apiErrorStatus)?entry.apiErrorStatus:Number(/^API Error:\s*(\d{3})\b/.exec(text)?.[1]);
  return {id:"error:"+entry.uuid,sessionId,at,outcome:status===401||status===403?"auth-error":"unknown"};
 }
 if(entry.error!=null||entry.apiErrorStatus!=null)return null;
 const message=entry.message,usage=message.usage;
 if(!identifier(entry.requestId)||!identifier(message.id)||message.type!=="message"||typeof message.model!=="string"||!/^claude-[\w.-]{1,100}$/.test(message.model)
  ||!["end_turn","tool_use","max_tokens","stop_sequence"].includes(message.stop_reason)
  ||!usage||![usage.input_tokens,usage.output_tokens].every(v=>Number.isSafeInteger(v)&&v>=0)||!Array.isArray(message.content))return null;
 return {id:"request:"+entry.requestId+":"+message.id,sessionId,at,outcome:"success"};
}
