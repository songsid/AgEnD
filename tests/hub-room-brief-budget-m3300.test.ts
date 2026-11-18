import {expect,it} from "vitest";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {formatRoomBrief,roomBriefSchema} from "../src/hub/room-brief-model.js";
import {formatRoomAskPrompt} from "../src/hub/member/room-ask.js";
const parts=(s:string)=>[...new Intl.Segmenter(undefined,{granularity:"grapheme"}).segment(s)].map(v=>v.segment);
for(const locale of ["en","zh-TW"] as const){
 const marker=locale==="en"?"… (cut: full purpose in hub_room_members)":"…（已截短，完整用途請用 hub_room_members 查詢）";
 it(`first brief preserves the existing normal200-character block exactly (${locale})`,()=>{
  const purpose=(locale==="en"?"p":"用").repeat(200),brief={kind:"first" as const,purpose,people:3,agents:4};
  const expected=readFileSync(join(import.meta.dirname,`fixtures/hub-room-brief-budget/first-${locale}.txt`),"utf8").trimEnd();
  expect(formatRoomBrief(brief,locale)).toBe(expected);expect(Buffer.byteLength(expected)).toBeLessThanOrEqual(2048);expect(expected).not.toContain(marker);
  const emoji=formatRoomBrief({...brief,purpose:"🙂".repeat(200)},locale);expect(emoji).toContain(JSON.stringify("🙂".repeat(200)));expect(emoji).not.toContain(marker);
 });
 it(`first brief at exactly2048 bytes stays intact;2049 cuts only purpose (${locale})`,()=>{
  const normal=(locale==="en"?"p":"用").repeat(200),baseline=readFileSync(join(import.meta.dirname,`fixtures/hub-room-brief-budget/first-${locale}.txt`),"utf8").trimEnd(),overhead=Buffer.byteLength(baseline)-Buffer.byteLength(normal);
  const purpose="xx"+"\u0301".repeat((2048-overhead-2)/2),brief={kind:"first" as const,purpose,people:3,agents:4},expected=baseline.replace(JSON.stringify(normal),JSON.stringify(purpose));
  expect(Buffer.byteLength(expected)).toBe(2048);expect(formatRoomBrief(brief,locale)).toBe(expected);
  const over=formatRoomBrief({...brief,purpose:purpose+"z"},locale);expect(over).toContain(marker);expect(Buffer.byteLength(over)).toBeLessThanOrEqual(2048);
 });
 it.each(["👨‍👩‍👧‍👦x".repeat(100),"x"+"\u0301".repeat(1300)])(`first brief cuts only whole purpose graphemes and includes all framing in2048 bytes (${locale})`,purpose=>{
  const brief={kind:"first" as const,purpose,people:1000000,agents:1000000};expect(roomBriefSchema.safeParse(brief).success).toBe(true);
  const ask={messageId:"m",roomId:"r",roomName:"Room",exposureId:"e",asker:{name:"Reader"},text:"Question",context:[],brief};
  const prompt=formatRoomAskPrompt(ask,"cid",locale),start=prompt.indexOf(locale==="en"?"The room details below":"以下房間資料"),block=prompt.slice(start).split("\n\n")[0];
  expect(Buffer.byteLength(block)).toBeLessThanOrEqual(2048);expect(block).toBe(formatRoomBrief(brief,locale));expect(block).toContain(marker);
  const purposePrefix=locale==="en"?"Purpose: ":"用途：",line=block.split("\n").find(s=>s.startsWith(purposePrefix))!,shown=JSON.parse(line.slice(purposePrefix.length,line.indexOf(marker)).trim());
  expect(parts(purpose).slice(0,parts(shown).length).join("")).toBe(shown);
  const fixed=formatRoomBrief({...brief,purpose:""},locale).split("\n").slice(-2).join("\n");expect(block.endsWith(fixed)).toBe(true);
  expect(brief.purpose).toBe(purpose); // the structured/stored value was not mutated
 });
}
