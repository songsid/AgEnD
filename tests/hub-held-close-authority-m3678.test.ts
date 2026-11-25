import { expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import type { ContactPerson } from "../src/contact-auth-types.js";
const admin: ContactPerson = { platform: "discord", adapterId: "demo-bot", userId: "demo-admin", label: "Demo admin" };
function rig() {
 const close=vi.fn(async()=>"closed" as const),poke=vi.fn();
 const fm:any=Object.assign(Object.create(FleetManager.prototype),{
  hubExecutionAttention:()=>[{id:"hold:demo",kind:"hold",agent:"demo-agent"}],hubHeldClose:close,needsYou:{poke},
  fleetConfig:{channels:[{id:"demo-bot",type:"discord"}],instances:{"demo-agent":{}}},
  adapters:new Map([["demo-bot",{id:"demo-bot",type:"discord"}]]),getInstanceAdapterId:()=>"demo-bot",
  isFleetAdmin:(id:string)=>id===admin.userId,classicChannels:{getAll:()=>[]},
 });return {fm,close,poke};
}
it.each([admin,{platform:"host",adapterId:"host",userId:"operator",label:"Host operator"} as ContactPerson])("a current managing $platform admin closes only the selected held item",async actor=>{
 const {fm,close,poke}=rig();expect(await fm.closeHubHeld("hub:hold:demo",actor)).toEqual({status:200,code:"closed"});
 expect(close).toHaveBeenCalledExactlyOnceWith("hold:demo");expect(poke).toHaveBeenCalledOnce();
});
it.each([{...admin,userId:"demo-member"},{...admin,platform:"telegram"} as ContactPerson])("a non-managing or wrong-platform actor cannot close",async actor=>{
 const {fm,close}=rig();expect(await fm.closeHubHeld("hub:hold:demo",actor)).toEqual({status:403,code:"forbidden"});expect(close).not.toHaveBeenCalled();
});
it("a missing item or detached Hub cannot invoke the callback",async()=>{
 const {fm,close}=rig();expect(await fm.closeHubHeld("hub:hold:other",admin)).toEqual({status:404,code:"not-found"});
 fm.hubHeldClose=null;expect(await fm.closeHubHeld("hub:hold:demo",admin)).toEqual({status:404,code:"not-found"});expect(close).not.toHaveBeenCalled();
});
