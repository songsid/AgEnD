import {expect,it} from "vitest";
import {randomUUID} from "node:crypto";
import {formatRoomAskPrompt,type RoomAsk} from "../src/hub/member/room-ask.js";
import {DEFAULT_MAX_CROSS_INSTANCE_MESSAGE_BYTES} from "../src/config.js";
const ask=():RoomAsk=>({messageId:randomUUID(),roomId:randomUUID(),exposureId:randomUUID(),roomName:"Fixture room",asker:{name:"A colleague"},text:"Current question stays exact",context:Array.from({length:31},(_,i)=>({author:"A colleague",text:`row-${i}-`+"x".repeat(2040),at:i+1,...(i===0?{repliedTo:true as const}:{})}))});
const data=(text:string)=>JSON.parse(text.split("```json\n")[1]!.split("\n```")[0]!);
const size=(rows:unknown)=>Buffer.byteLength(JSON.stringify({context:rows},null,2));
it.each(["en","zh-TW"] as const)("H7 default history fits12KiB, keeps newest and counts omitted rows (%s)",locale=>{
 const input=ask(),text=formatRoomAskPrompt(input,"hub-room-owned",locale),parsed=data(text);
 expect(size(parsed.context)).toBeLessThanOrEqual(DEFAULT_MAX_CROSS_INSTANCE_MESSAGE_BYTES);
 expect(parsed.context.at(-1)).toEqual(input.context.at(-1));expect(parsed.context[0].text).not.toBe(input.context[0]!.text);
 expect(parsed.question).toEqual({asker:input.asker.name,text:input.text});
 const dropped=input.context.length-parsed.context.length;expect(text).toContain(locale==="en"?`${dropped} earlier messages are not shown.`:`還有 ${dropped} 則較早的訊息沒有顯示。`);
 expect(input.context).toHaveLength(31);
});
it.each([512,4096,24000])("H7 uses configured history budget%s including JSON escaping",maxContextBytes=>{
 const input=ask();input.context=input.context.map(row=>({...row,text:row.text+"\n\"\\".repeat(50)}));
 const parsed=data(formatRoomAskPrompt(input,"hub-room-owned","en",{maxContextBytes}));
 expect(size(parsed.context)).toBeLessThanOrEqual(maxContextBytes);expect(parsed.question.text).toBe(input.text);
});
it("H7 clips a single oversized newest message at a Unicode boundary with exact missing-byte count",()=>{
 const input=ask();input.text="Q".repeat(20000);input.context=[{author:"A colleague",text:"older",at:1},{author:"A colleague",text:"🧭漢\n\"".repeat(3000),at:2}];
 const parsed=data(formatRoomAskPrompt(input,"hub-room-owned","en",{maxContextBytes:512}));expect(size(parsed.context)).toBeLessThanOrEqual(512);expect(parsed.context).toHaveLength(1);
 const text=parsed.context[0].text as string,match=text.match(/\n\(cut: (\d+) bytes not shown\)$/)!;expect(match).toBeTruthy();
 const prefix=text.slice(0,-match[0].length);expect(Number(match[1])).toBe(Buffer.byteLength(input.context[1]!.text)-Buffer.byteLength(prefix));expect(input.context[1]!.text.startsWith(prefix)).toBe(true);
 expect(prefix).not.toMatch(/[\uD800-\uDBFF]$/);expect(parsed.question.text).toBe(input.text);
});
it("H7 leaves a fitting window and question unchanged",()=>{
 const input=ask();input.context=[{author:"A colleague",text:"small",at:1,repliedTo:true}];const text=formatRoomAskPrompt(input,"hub-room-owned");
 expect(data(text)).toEqual({context:input.context,question:{asker:input.asker.name,text:input.text}});expect(text).not.toContain("earlier messages are not shown");
});

it("H7 an extremely small configured limit omits history rather than cutting the question",()=>{const input=ask(),parsed=data(formatRoomAskPrompt(input,"hub-room-owned","en",{maxContextBytes:1}));expect(parsed.context).toBeUndefined();expect(parsed.question.text).toBe(input.text);});
