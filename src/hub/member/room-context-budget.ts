/** Fleet-local rendering budget; neither the retained ask nor its confirmed Hub cursor is changed. */
import {DEFAULT_MAX_CROSS_INSTANCE_MESSAGE_BYTES} from "../../config.js";
import type {RoomContextRow} from "./room-ask.js";
const bytes=(rows:readonly RoomContextRow[])=>Buffer.byteLength(JSON.stringify({context:rows},null,2),"utf8");
export function budgetRoomContext(rows:readonly RoomContextRow[],requested=DEFAULT_MAX_CROSS_INSTANCE_MESSAGE_BYTES):{context:readonly RoomContextRow[]|undefined;omitted:number}{
 const limit=Number.isSafeInteger(requested)&&requested>0?requested:DEFAULT_MAX_CROSS_INSTANCE_MESSAGE_BYTES;
 if(bytes(rows)<=limit)return{context:rows,omitted:0};
 // A configuration can be smaller than even an empty JSON history; omit that field rather than exceed it.
 if(bytes([])>limit)return{context:undefined,omitted:rows.length};
 let start=rows.length;
 while(start>0&&bytes(rows.slice(start-1))<=limit)start--;
 if(start<rows.length)return{context:rows.slice(start),omitted:start};
 const newest=rows.at(-1);if(!newest)return{context:[],omitted:0};
 const chars=Array.from(newest.text),total=Buffer.byteLength(newest.text,"utf8");
 const clipped=(n:number)=>{const prefix=chars.slice(0,n).join("");return{...newest,text:`${prefix}\n(cut: ${total-Buffer.byteLength(prefix,"utf8")} bytes not shown)`};};
 // Metadata and the cut marker are also charged. With no room for those, keep no partial/fabricated row.
 if(bytes([clipped(0)])>limit)return{context:[],omitted:rows.length};
 let lo=0,hi=chars.length-1;
 while(lo<hi){const mid=Math.ceil((lo+hi)/2);if(bytes([clipped(mid)])<=limit)lo=mid;else hi=mid-1;}
 return{context:[clipped(lo)],omitted:rows.length-1};
}
