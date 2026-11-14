import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { page } from "./helpers/app-harness.js";
import { counts, shouldNotify } from "/ui/js/hub-room-unread.js";
let thread:any, i18n:any;
beforeAll(async()=>{const p=page(); i18n=await import("/assets/app-i18n.js"); thread=await import("/ui/js/hub-room-thread.js");p.restore();});
afterEach(()=>{vi.unstubAllGlobals();i18n.setLang("en",{store:false});});
it("keeps proactive posts unread but notifies only an explicitly mentioned person",()=>{
  vi.stubGlobal("localStorage",{getItem:()=>"1"});
  class Notification {static permission="granted";}
  const env={Notification,navigator:{userAgent:"Mozilla/5.0 Chrome"},isSecureContext:true};
  const me={id:"alex"}, message={id:"post",text:"Morning update",author:{kind:"agent",id:"notes"},proactive:true,mentions:[] as string[]};
  const event={type:"message.added",message};
  expect(counts(event,me)).toMatchObject({unread:1,mentioned:false});expect(shouldNotify(event,me,false,env)).toBe(false);
  message.mentions=["alex"];expect(shouldNotify(event,me,false,env)).toBe(true);
  message.proactive=false;message.mentions=[];expect(shouldNotify(event,me,false,env)).toBe(true);
});
it("localizes a stop directly below its source without a timestamp, retaining cached/unknown fallbacks",()=>{
  const post={id:"post",roomId:"room",at:1,author:{kind:"agent",id:"a",name:"Notes"},text:"@Planner again",mentions:[]};
  const human={...post,id:"later",author:{kind:"person",id:"alex",name:"Alex"},text:"A later human message"};
  const stop={...post,id:"stop",author:{kind:"system",name:"",id:"system"},text:"English fallback",system:{kind:"agent-mention-stopped",sourceId:"post",reason:"depth",name:"Notes"}};
  i18n.setLang("zh-TW",{store:false});
  const rows=thread.toThreadMessages([post,human,stop],{meId:"viewer",ids:new Map()});
  expect(rows[1].text).toContain("先停在這裡");expect(rows[1].ts).toBeUndefined();expect(rows[1].wrap).toBe(true);expect(rows[2].text).toBe(human.text);
  expect(thread.systemText({...stop,system:{kind:"future",name:""}})).toBe("English fallback");
  expect(thread.authorLine({kind:"person",name:"Alex",via:{id:"notes",name:"Notes"}})).toBe("Alex 透過 Notes");
  i18n.setLang("en",{store:false});expect(thread.authorLine({kind:"person",name:"Alex",via:{name:"Notes"}})).toBe("Alex via Notes");
  const via={...post,author:{kind:"person",id:"viewer",name:"Alex",via:{id:"notes",name:"Notes"}}};
  const row=thread.toThreadMessages([via],{meId:"viewer",ids:new Map()})[0];
  expect(row).toMatchObject({role:"agent",mine:false,sender:"Alex via Notes"});expect(row.person).toBeUndefined();
});
