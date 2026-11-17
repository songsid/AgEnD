import {expect,it} from "vitest";
import {pageRoomMembers} from "../src/hub/rooms/members-page.js";
import {roomMembersSchema} from "../src/hub/protocol.js";
import {randomUUID} from "node:crypto";
const room=randomUUID();
const roster=Array.from({length:80},(_,i)=>({id:String(i),kind:"agent" as const,name:`Agent ${String(i).padStart(2,"0")}`,owner:{name:"Owner"},intro:"Helps with documents.",presence:i%2?"offline":"idle"}));
it("H5 defaults20/max50 with counts, readiness/name order, hint and exact continuation",()=>{
 const first:any=pageRoomMembers(room,"Purpose",roster,{},"scope");expect(first.counts).toEqual({people:0,agents:80,assistant:false,matched:80,returned:20});expect(first.hint).toBe("Add a query to narrow this.");expect(first.members[0].name).toBe("Agent 00");expect(first.members[1].name).toBe("Agent 02");
 const second:any=pageRoomMembers(room,"Purpose",roster,{cursor:first.next_cursor,limit:50},"scope");expect(second.counts.returned).toBe(50);expect(second.members[0].name).toBe("Agent 40");
 expect(roomMembersSchema.safeParse({exposureId:randomUUID(),room,v2:true,limit:51}).success).toBe(false);expect(roomMembersSchema.safeParse({exposureId:randomUUID(),room,query:"x"}).success).toBe(false);
});
it("H5 whole rows and the full JSON stay under8KiB including cursor/count metadata",()=>{
 const large=roster.map(m=>({...m,name:m.name+"字".repeat(60),owner:{name:"擁有者".repeat(20)},intro:"描述".repeat(100)}));let cursor:string|undefined;const ids:string[]=[];
 do{const page:any=pageRoomMembers(room,"用途",large,{limit:50,...(cursor?{cursor}:{})},"scope");expect(page.ok).toBe(true);expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(8192);expect(page.members.length).toBeGreaterThan(0);for(const row of page.members){expect(row.intro).toBe("描述".repeat(100));ids.push(row.id);}cursor=page.next_cursor;}while(cursor);
 expect(ids).toHaveLength(80);expect(new Set(ids).size).toBe(80);
 expect(pageRoomMembers(room,"x".repeat(9000),roster,{},"scope")).toEqual({ok:false,code:"backpressure"});
});
it("H5 searches name/owner/intro case-insensitively, exact name wins, kind filters and stale cursors disclose no rows",()=>{
 const rows=[{...roster[0],name:"Notes",intro:"Release work"},{...roster[1],name:"Other",owner:{name:"NOTES owner"}},{id:"p",kind:"person" as const,name:"Notes reader",presence:"online"}];
 const page:any=pageRoomMembers(room,"",rows,{query:"nOtEs"},"scope");expect(page.members.map((r:any)=>r.id)).toEqual(["0","p","1"]);expect(page.counts).toMatchObject({people:1,agents:2,matched:3});
 expect((pageRoomMembers(room,"",rows,{query:"release"},"scope") as any).members.map((r:any)=>r.id)).toEqual(["0"]);
 expect((pageRoomMembers(room,"",rows,{kind:"person"},"scope") as any).members[0]).not.toHaveProperty("intro");
 const cursor=(pageRoomMembers(room,"",rows,{limit:1},"scope") as any).next_cursor;
 for(const [query,scope] of [["other","scope"],[undefined,"foreign"]])expect(pageRoomMembers(room,"",rows,{cursor,query},scope!)).toEqual({ok:false,code:"stale"});
 expect(pageRoomMembers(room,"",rows.slice(1),{cursor},"scope")).toEqual({ok:false,code:"stale"});
});

it("H5 assistant is separate, unmentionable, ownerless and between agents/people; agent filter excludes it",()=>{
 const assistant={id:"assistant",kind:"assistant" as const,name:"Hub assistant",intro:"Hub assistant. Answers from this room's chat.",presence:"idle",mentionable:false as const};
 const person={id:"p",kind:"person" as const,name:"A reader",presence:"online"};const rows=[person,assistant,roster[0]];
 const page:any=pageRoomMembers(room,"",rows,{},"scope");expect(page.counts).toEqual({people:1,agents:1,assistant:true,matched:3,returned:3});expect(page.members.map((r:any)=>r.kind)).toEqual(["agent","assistant","person"]);expect(page.members[1]).toEqual(assistant);
 expect((pageRoomMembers(room,"",rows,{kind:"agent"},"scope") as any).members.map((r:any)=>r.kind)).toEqual(["agent"]);
 expect((pageRoomMembers(room,"",rows,{query:"assistant"},"scope") as any).members).toEqual([assistant]);
});
