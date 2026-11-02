import { describe, expect, it } from "vitest";
import { WebChatHistory, WEB_CHAT_TEXT_MAX, type NativeHistoryMessage, type StoredWebChatMessage } from "../src/web-chat-history.js";

const instance="windows-12345678-1234-4321-abcd-123456789012";
const turn="12345678-1234-4321-abcd-123456789013", other="12345678-1234-4321-abcd-123456789014";
const ts="2026-11-02T01:00:00.123Z";
const expected=(part:"user"|"reply",id=turn,patch:Partial<NativeHistoryMessage>={}):NativeHistoryMessage=>({
  messageId:`native:${id}:${part}`,role:part==="user"?"user":"agent",sender:part==="user"?"You":"Windows helper",text:part==="user"?"question":"answer",ts,...patch,
});
function recorded(messages:NativeHistoryMessage[]) {
  let rows:StoredWebChatMessage[]=[];
  const history=new WebChatHistory({boot:"aa",store:{schedule(_name,snapshot){rows=snapshot();},remove:async()=>{}}});
  for(const message of messages)history.record({instance,...message});
  return {history,rows:()=>rows};
}

describe("native chat turn identities across fleet restarts",()=>{
  it("persists only role-valid native turn ids and never restores delivery ticks or buttons",()=>{
    const f=recorded([]);
    f.history.record({instance,...expected("user"),buttons:{id:"a".repeat(32),labels:["OK"],state:"open"}});
    f.history.setDelivery(instance,expected("user").messageId,"delivered");
    f.history.record({instance,...expected("reply"),buttons:{id:"a".repeat(32),labels:["OK"],state:"open"}});
    f.history.record({instance,...expected("user"),messageId:"web-ordinary"});
    f.history.record({instance,...expected("user"),messageId:`native:${turn}:reply`});
    f.history.record({instance,...expected("reply"),messageId:"native:not-a-uuid:reply"});
    const restored=new WebChatHistory({boot:"bb"});restored.restore(instance,f.rows());
    expect(restored.list(instance).map(m=>m.messageId)).toEqual([`native:${turn}:user`,`native:${turn}:reply`,undefined,undefined,undefined]);
    expect(restored.list(instance).every(m=>m.delivery===undefined&&m.buttons===undefined)).toBe(true);
  });

  it("repairs repeated legacy imports using authoritative turn timestamps and keeps earliest row cursors",()=>{
    const history=new WebChatHistory({boot:"cc"});
    const rows=["aa","bb"].flatMap(boot=>[expected("user"),expected("reply")].map((message,index)=>({instance,boot,id:index+1,...message,messageId:undefined})));
    history.restore(instance,rows);
    expect(history.reconcileNativeMessages(instance,[expected("user"),expected("reply")])).toBe(true);
    expect(history.list(instance).map(m=>[m.boot,m.id,m.messageId])).toEqual([["aa",1,`native:${turn}:user`],["aa",2,`native:${turn}:reply`]]);
    expect(history.reconcileNativeMessages(instance,[expected("user"),expected("reply")])).toBe(false);
  });

  it("retains distinct native turns with identical content and exact timestamps as a multiset",()=>{
    const history=new WebChatHistory({boot:"cc"});
    history.restore(instance,[1,2,3,4].map(id=>({instance,boot:"aa",id,...expected("user"),messageId:undefined})));
    history.reconcileNativeMessages(instance,[expected("user"),expected("user",other)]);
    expect(history.list(instance).map(m=>[m.id,m.messageId])).toEqual([[1,`native:${turn}:user`],[2,`native:${other}:user`]]);
  });

  it("keeps a known native identity when an older anonymous row belongs to an indistinguishable separate turn",()=>{
    const history=new WebChatHistory({boot:"cc"});
    history.restore(instance,[
      {instance,boot:"aa",id:1,...expected("user"),messageId:undefined},
      {instance,boot:"aa",id:2,...expected("user")},
    ]);
    history.reconcileNativeMessages(instance,[expected("user"),expected("user",other)]);
    expect(history.list(instance).map(m=>[m.id,m.messageId])).toEqual([[1,`native:${other}:user`],[2,`native:${turn}:user`]]);
  });

  it("does not merge ordinary repeats, other timestamps, other message identities or rows with chat metadata",()=>{
    const history=new WebChatHistory({boot:"bb"}), message=expected("user");
    history.restore(instance,[
      {instance,boot:"aa",id:1,...message,messageId:undefined},
      {instance,boot:"aa",id:2,...message,messageId:undefined,ts:"2026-11-02T01:00:00.124Z"},
      {instance,boot:"aa",id:3,...message,messageId:`native:${other}:user`},
      {instance,boot:"aa",id:4,...message,messageId:undefined,from:"account:user",channel:true},
      {instance,boot:"aa",id:5,...message,messageId:undefined,role:"agent"},
    ]);
    history.reconcileNativeMessages(instance,[message]);
    expect(history.list(instance).map(m=>m.id)).toEqual([1,2,3,4,5]);
    expect(history.list(instance)[0].messageId).toBe(message.messageId);
    expect(history.list(instance)[2].messageId).toBe(`native:${other}:user`);
  });

  it("matches replies using the same text bound as recording and persists a repair without adding messages",()=>{
    let rows:StoredWebChatMessage[]=[];
    const history=new WebChatHistory({boot:"bb",store:{schedule(_name,snapshot){rows=snapshot();},remove:async()=>{}}});
    const reply=expected("reply",turn,{text:"x".repeat(WEB_CHAT_TEXT_MAX+100)});
    history.restore(instance,[1,2].map(id=>({instance,boot:"aa",id,...reply,text:reply.text.slice(0,WEB_CHAT_TEXT_MAX),messageId:undefined})));
    history.reconcileNativeMessages(instance,[reply]);
    expect(rows).toHaveLength(1);expect(rows[0].messageId).toBe(reply.messageId);
    const restarted=new WebChatHistory({boot:"cc"});restarted.restore(instance,rows);
    expect(restarted.findByMessageId(instance,reply.messageId)?.text.length).toBe(WEB_CHAT_TEXT_MAX);
    expect(restarted.reconcileNativeMessages(instance,[reply])).toBe(false);
  });
});
