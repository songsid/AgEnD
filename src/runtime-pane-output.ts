/** Bounded raw-output ring. The runner never accepts a coordinator log path. */
export const PANE_OUTPUT_CHUNK=128*1024;
export interface PaneOutputBatch {from:number;next:number;gap:boolean;data:string;exited:boolean}
export function validatePaneOutputBatch(value:unknown,requested:number):PaneOutputBatch{
 if(!value||typeof value!=="object"||Array.isArray(value))throw Error("Invalid pane output frame");const v=value as PaneOutputBatch;
 if(Object.keys(v).some(key=>!["from","next","gap","data","exited"].includes(key))||!Number.isSafeInteger(v.from)||!Number.isSafeInteger(v.next)||v.from<requested||v.next<v.from
  ||typeof v.gap!=="boolean"||v.gap!==(v.from!==requested)||typeof v.exited!=="boolean"||typeof v.data!=="string"||v.data.length>Math.ceil(PANE_OUTPUT_CHUNK/3)*4
  ||Buffer.from(v.data,"base64").toString("base64")!==v.data||Buffer.from(v.data,"base64").length!==v.next-v.from)throw Error("Invalid pane output frame");return v;
}
export class RuntimePaneOutputBuffer{
 private chunks:Buffer[]=[];private retained=0;private total=0;
 constructor(private limit=4*1024*1024){}
 append(text:string):void{let bytes=Buffer.from(text);if(!bytes.length)return;this.total+=bytes.length;if(!Number.isSafeInteger(this.total))throw Error("Pane output offset overflow");if(bytes.length>this.limit)bytes=bytes.subarray(bytes.length-this.limit);this.chunks.push(bytes);this.retained+=bytes.length;while(this.chunks.length>1024){this.retained-=this.chunks.shift()!.length;}while(this.retained>this.limit){const excess=this.retained-this.limit,head=this.chunks[0];if(head.length<=excess){this.chunks.shift();this.retained-=head.length;}else{this.chunks[0]=head.subarray(excess);this.retained-=excess;}}}
 read(offset:number,exited:boolean):PaneOutputBatch{
  if(!Number.isSafeInteger(offset)||offset<0||offset>this.total)throw Error("Pane output cursor differs");const oldest=this.total-this.retained,from=Math.max(offset,oldest),end=Math.min(this.total,from+PANE_OUTPUT_CHUNK),pieces:Buffer[]=[];let at=oldest;
  for(const chunk of this.chunks){const finish=at+chunk.length;if(finish>from&&at<end)pieces.push(chunk.subarray(Math.max(0,from-at),Math.min(chunk.length,end-at)));at=finish;if(at>=end)break;}
  return{from,next:end,gap:from!==offset,data:Buffer.concat(pieces).toString("base64"),exited};
 }
}
