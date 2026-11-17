import {afterEach,beforeAll,expect,it,vi} from "vitest";
import {page,h,settle,type AppPage} from "./helpers/app-harness.js";
import {fire} from "./helpers/mini-dom.js";
let create:any,settings:any,purpose:any,thread:any,words:any;const pages:AppPage[]=[];
beforeAll(async()=>{const p=page();create=await import("/ui/js/hub-room-new.js");settings=await import("/ui/js/hub-room-settings.js");purpose=await import("/ui/js/hub-room-purpose.js");thread=await import("/ui/js/hub-room-thread.js");words=await import("/assets/app-i18n.js");p.restore();});
afterEach(async()=>{for(const p of pages.splice(0)){await p.unmount();p.restore();}vi.restoreAllMocks();});
const button=(p:AppPage,label:string)=>[...p.root.querySelectorAll("button")].find((el:any)=>el.textContent.trim()===label);
const type=async(p:AppPage,id:string,value:string)=>{const el=p.root.querySelector(id);expect(el).toBeTruthy();el.value=value;fire(el,"input");await settle();};
it.each(["en","zh-TW"])("creates with the optional purpose and refuses 201 visible characters (%s)",async lang=>{
 const p=page();pages.push(p);words.setLang(lang,{store:false});const save=vi.fn(async(_input:any)=>({ok:true,room:{id:"room"}}));
 await p.mount(h(create.NewRoomDialog,{client:{createRoom:save,roomCandidates:async()=>({ok:true,candidates:[]})},assistant:false,purposeSupported:true}));
 await type(p,"#hubRoomName","Release room");await type(p,"#hubRoomPurpose","界".repeat(201));expect(button(p,lang==="en"?"Create":"建立")?.disabled).toBe(true);
 await type(p,"#hubRoomPurpose","Release questions");fire(button(p,lang==="en"?"Create":"建立"),"click");await settle();expect(save).toHaveBeenCalledWith(expect.objectContaining({name:"Release room",purpose:"Release questions"}));
});
it("keeps the old create shape when purpose is not offered",async()=>{
 const p=page();pages.push(p);words.setLang("en",{store:false});const save=vi.fn(async(_input:any)=>({ok:true,room:{id:"room"}}));
 await p.mount(h(create.NewRoomDialog,{client:{createRoom:save,roomCandidates:async()=>({ok:true,candidates:[]})},assistant:false}));expect(p.root.querySelector("#hubRoomPurpose")).toBeNull();
 await type(p,"#hubRoomName","Room");fire(button(p,"Create"),"click");await settle();expect(save.mock.calls[0]?.[0]).not.toHaveProperty("purpose");
});
it("saves only purpose and preserves a refused edit for retry",async()=>{
 const p=page();pages.push(p);words.setLang("en",{store:false});const update=vi.fn().mockResolvedValueOnce({ok:false,status:503}).mockResolvedValueOnce({ok:true}),changed=vi.fn();
 const detail={room:{id:"room",name:"Room",kind:"group",purpose:"Before"},me:{id:"owner",role:"manager"},members:[],settings:{allMention:true,historyForNew:"since-join"}};
 await p.mount(h(settings.RoomSettings,{client:{roomPurposeV1:true,updateRoom:update},roomId:"room",detail,assistant:false,onChanged:changed}));await type(p,"#hubRoomSettingsPurpose","Reviewed purpose");fire(p.root.querySelector(".hub-room-purpose-form"),"submit");await settle();
 expect(update).toHaveBeenCalledWith("room",{purpose:"Reviewed purpose"});expect(p.root.querySelector("#hubRoomSettingsPurpose")?.value).toBe("Reviewed purpose");expect(changed).not.toHaveBeenCalled();
 fire(p.root.querySelector(".hub-room-purpose-form"),"submit");await settle();expect(changed).toHaveBeenCalledTimes(1);
});
it.each(["en","zh-TW"])("opens the full purpose and localizes set/clear events without parsing prose (%s)",async lang=>{
 const p=page();pages.push(p);words.setLang(lang,{store:false});const text="A room purpose ".repeat(10);
 await p.mount(h(purpose.RoomPurposeHeader,{purpose:text}));fire(p.root.querySelector(".hub-room-purpose-trigger"),"click");await settle();expect(p.root.querySelector(".hub-room-purpose-full")?.textContent).toBe(text);
 expect(thread.systemText({system:{kind:"purpose-changed",name:"Owner",purpose:"Release questions"}})).toBe(lang==="en"?"Owner set the purpose: Release questions":"Owner 設定了用途：Release questions");
 expect(thread.systemText({system:{kind:"purpose-changed",name:"Owner",purpose:""}})).toBe(lang==="en"?"Owner cleared the purpose.":"Owner 清除了用途。");
 expect(thread.systemText({system:{kind:"purpose-changed",name:"Owner"},text:"legacy fallback"})).toBe("legacy fallback");
});
