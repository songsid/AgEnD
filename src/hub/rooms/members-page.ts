import {createHash} from "node:crypto";
import type {BoundedRoomMember,RoomMemberOptions} from "../room-members-model.js";
const bytes=(v:unknown)=>Buffer.byteLength(JSON.stringify(v));
const fold=(s:string)=>s.normalize("NFC").toLocaleLowerCase("en");
export function pageRoomMembers(roomId:string,purpose:string,roster:BoundedRoomMember[],options:RoomMemberOptions,scope:string){
 const rank={agent:0,assistant:1,person:2};
 const query=fold(options.query?.trim()??""),ready=(m:BoundedRoomMember)=>["idle","working","online"].includes(m.presence)?0:1;
 const score=(m:BoundedRoomMember)=>!query?0:fold(m.name)===query?0:fold(m.name).startsWith(query)?1:fold(m.name).includes(query)?2:fold(m.owner?.name??"").includes(query)?3:4;
 const matched=roster.filter(m=>(!options.kind||m.kind===options.kind)&&(!query||[m.name,m.owner?.name??"",m.intro??""].some(s=>fold(s).includes(query))))
 .sort((a,b)=>score(a)-score(b)||(rank[a.kind]-rank[b.kind])||ready(a)-ready(b)||a.name.localeCompare(b.name,"en")||a.id.localeCompare(b.id));
 const hash=createHash("sha256").update(JSON.stringify([scope,roomId,purpose,query,options.kind??null,matched.map(({presence,...stable})=>stable)])).digest("hex");
 let offset=0;
 if(options.cursor){try{const v=JSON.parse(Buffer.from(options.cursor,"base64url").toString("utf8"));if(v.hash!==hash||!Number.isSafeInteger(v.offset)||v.offset<1||v.offset>=matched.length)throw Error();offset=v.offset;}catch{return {ok:false as const,code:"stale" as const};}}
 const rows:BoundedRoomMember[]=[],limit=options.limit??20;
 const result=()=>({ok:true as const,v2:true as const,roomId,purpose,counts:{people:roster.filter(m=>m.kind==="person").length,agents:roster.filter(m=>m.kind==="agent").length,assistant:roster.some(m=>m.kind==="assistant"),matched:matched.length,returned:rows.length},members:rows,
 ...(offset+rows.length<matched.length?{next_cursor:Buffer.from(JSON.stringify({hash,offset:offset+rows.length})).toString("base64url")} : {}),...(!query&&matched.length>limit?{hint:"Add a query to narrow this."}:{})});
 for(const row of matched.slice(offset,offset+limit)){rows.push(row);if(bytes(result())>8192){rows.pop();break;}}
 if(bytes(result())>8192||offset<matched.length&&!rows.length)return {ok:false as const,code:"backpressure" as const};
 return result();
}
