import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { roomContext } from "../src/hub/rooms/context.js";
import type { HubCore } from "../src/hub/http/core.js";
import { migrateRoomContext, RoomContextCursor } from "../src/hub/rooms/context-cursor.js";
import { randomUUID } from "node:crypto";

const stores: Database.Database[] = [];
afterEach(() => { for (const db of stores.splice(0)) db.close(); });
function fixture() {
  const db = new Database(":memory:"); stores.push(db);
  db.exec(`CREATE TABLE hub_room_posts(id TEXT,room_id TEXT,sequence INTEGER,author_name TEXT,content_ref TEXT,created_at INTEGER,author_kind TEXT,stage TEXT);
    CREATE TABLE hub_room_post_lineage(post_id TEXT,audience_sequence INTEGER);`);
  const content = new Map<string, {question:string}>();
  for (let n = 1; n <= 6; n++) {
    content.set(`c${n}`, {question:`Message ${n}`});
    db.prepare("INSERT INTO hub_room_posts VALUES(?,?,?,?,?,?,?,NULL)").run(`p${n}`,"room",n,"Alex",`c${n}`,n,"person");
  }
  return {db, core:{deps:{content:{get:(id:string)=>content.get(id)}}} as HubCore};
}
it("sends only posts after the last confirmed ask while retaining its visible older reply anchor", () => {
  const {db,core}=fixture(),post={id:"p6",room_id:"room",sequence:6,reply_to:"p1"};
  expect(roomContext(core,db,post,1).map(r=>r.text)).toEqual(["Message 1","Message 2","Message 3","Message 4","Message 5"]);
  // The extra argument is deliberately ignored by the old production function: a semantic baseline red.
  const delta=(roomContext as (...args:any[])=>ReturnType<typeof roomContext>)(core,db,post,1,3);
  expect(delta.map(r=>r.text)).toEqual(["Message 1","Message 4","Message 5"]);
  expect(delta[0].repliedTo).toBe(true);
});
it("keeps cursors across reconnect, resets once, and rejects old generations, gaps and duplicate regressions", () => {
  const {db}=fixture(); migrateRoomContext(db);
  const cursor=new RoomContextCursor(db),g1=randomUUID(),g2=randomUUID();
  expect(cursor.observe("agent","binding",g1,1)).toBe(true);
  const first=cursor.snapshot("room","agent","binding",4,1)!;
  const overlapping=cursor.snapshot("room","agent","binding",6,1)!;
  expect(first).toEqual({generation:g1,after:0,through:4});
  expect(overlapping.after).toBe(0); // Both frozen windows contain everything after the same confirmed ask.
  expect(cursor.received("room","agent","binding",g1,{generation:g1,after:9,through:10})).toBe(false);
  expect(cursor.received("room","agent","binding",g1,overlapping)).toBe(true);
  expect(cursor.received("room","agent","binding",g1,first)).toBe(true);
  expect(cursor.position("room","agent","binding",g1)).toBe(6);
  expect(cursor.observe("agent","binding",g1,2)).toBe(true);
  expect(cursor.snapshot("room","agent","binding",8,1)).toBeNull();
  expect(cursor.snapshot("room","agent","binding",8,2)).toEqual({generation:g1,after:6,through:8});
  expect(cursor.observe("agent","binding",g2,2)).toBe(true);
  expect(cursor.snapshot("room","agent","binding",9,2)?.after).toBe(0);
  expect(cursor.received("room","agent","binding",g1,overlapping)).toBe(false);
  expect(cursor.observe("agent","binding",g1,2)).toBe(false);
  expect(cursor.snapshot("other-room","agent","binding",9,2)?.after).toBe(0);
  expect(cursor.snapshot("room","other-agent","binding",9,2)).toBeNull();
});
