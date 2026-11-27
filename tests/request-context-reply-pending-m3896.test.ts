import {expect,it,vi,afterEach} from "vitest";
import {RequestContextPendingReplies} from "../src/request-context-reply-pending.js";
import type {RequestContextTurnSnapshot} from "../src/request-context-turns.js";
import type {TurnReplyRouteLease} from "../src/turn-reply-guard.js";
afterEach(()=>vi.useRealTimers());
const snapshot=(inputId="human:hmsg-a",wireSha256="a".repeat(64))=>({inputId,wireSha256,token:"token-a",owner:{instance:"worker",daemonBootId:"boot"}} as RequestContextTurnSnapshot);
const route=(binding="token-a",chatId="chat-a")=>({binding,target:{chatId},current:()=>true} as TurnReplyRouteLease);
it("waits for both the exact arm and accepted confirmation, in either order",async()=>{
 for(const first of ["arm","confirm"]){
  const registry=new RequestContextPendingReplies(),a=snapshot(),row=registry.stage(a,a.inputId,a.wireSha256,()=>true)!;
  let done=false;const waiting=row.wait(100).then(value=>{done=true;return value;});
  if(first==="arm")row.arm(route());else row.confirm();
  await Promise.resolve();expect(done).toBe(false);
  if(first==="arm")row.confirm();else row.arm(route());
  expect((await waiting)?.target.chatId).toBe("chat-a");
 }
});
it("A's captured waiter cannot take steer B's arm or route even with the same C token",async()=>{
 const registry=new RequestContextPendingReplies(),a=snapshot(),b=snapshot("human:hmsg-b","b".repeat(64));
 const ra=registry.stage(a,a.inputId,a.wireSha256,()=>true)!,rb=registry.stage(b,b.inputId,b.wireSha256,()=>true)!;
 let done=false;const waiting=registry.capture(a)!.wait(100).then(value=>{done=true;return value;});
 rb.arm(route("token-a","chat-b"));rb.confirm();await Promise.resolve();expect(done).toBe(false);
 ra.arm(route());ra.confirm();expect((await waiting)?.target.chatId).toBe("chat-a");
});
it("expiry permanently refuses the captured record; a late arm cannot resurrect it",async()=>{
 vi.useFakeTimers();const registry=new RequestContextPendingReplies(),a=snapshot(),row=registry.stage(a,a.inputId,a.wireSha256,()=>true)!;
 const waiting=row.wait(10);await vi.advanceTimersByTimeAsync(10);expect(await waiting).toBeUndefined();
 row.confirm();row.arm(route());expect(await row.wait(10)).toBeUndefined();expect(registry.capture(a)).toBeUndefined();
});
it("owner replacement, wrong token and explicit failure never release a reply",async()=>{
 for(const failure of ["owner","token","refuse"]){
  let current=true;const registry=new RequestContextPendingReplies(),a=snapshot(),row=registry.stage(a,a.inputId,a.wireSha256,()=>current)!;
  const waiting=row.wait(100);row.confirm();
  if(failure==="owner")current=false;
  if(failure==="refuse")row.refuse();else row.arm(route(failure==="token"?"token-b":"token-a"));
  expect(await waiting).toBeUndefined();
 }
});
it("restart-style clear refuses every waiter and retains no old owner",async()=>{
 const registry=new RequestContextPendingReplies(),a=snapshot(),row=registry.stage(a,a.inputId,a.wireSha256,()=>true)!,waiting=row.wait(100);
 registry.clear();expect(await waiting).toBeUndefined();expect(registry.capture(a)).toBeUndefined();
});
it("the same input and bytes on a replacement token cannot capture the old waiter",()=>{
 const registry=new RequestContextPendingReplies(),a=snapshot();registry.stage(a,a.inputId,a.wireSha256,()=>true)!;
 expect(registry.capture({...a,token:"replacement-token"})).toBeUndefined();
 registry.clear();
});
it("capacity is bounded and a duplicate refuses its old waiter without replacing it",async()=>{
 const registry=new RequestContextPendingReplies();
 for(let n=0;n<129;n++){
  const a=snapshot(`human:hmsg-${n}`);
  const pending=registry.stage(a,a.inputId,a.wireSha256,()=>true);
  expect(!!pending).toBe(n<128);
 }
 const a=snapshot("human:hmsg-0"),old=registry.capture(a)!,waiting=old.wait(100);
 expect(registry.stage(a,a.inputId,a.wireSha256,()=>true)).toBeUndefined();
 expect(await waiting).toBeUndefined();expect(registry.capture(a)).toBeUndefined();
 const next=registry.stage(a,a.inputId,a.wireSha256,()=>true)!;
 old.refuse();expect(registry.capture(a)).toBe(next);
 registry.clear();
});
