import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { DeliveryOutbox } from "../src/delivery-outbox.js";
const cleanup:Array<()=>void>=[];
afterEach(()=>{for(const fn of cleanup.splice(0).reverse())fn();});
function rig(){
 const home=mkdtempSync(join(tmpdir(),"s226-legacy-"));cleanup.push(()=>rmSync(home,{recursive:true,force:true}));
 const box=new DeliveryOutbox(join(home,"outbox.db"));cleanup.push(()=>box.close());
 const fm:any=Object.assign(Object.create(FleetManager.prototype),{deliveryOutbox:box,lifecycle:{daemons:new Map()},scheduleDeliveryOutboxPump:vi.fn(),getDaemonBootId:()=>"boot",ensureDeliveryOutbox:()=>{},contactGeneration:()=>"generation",contactAdminOf:()=>true});
 const request={operationId:randomUUID(),source:"source",target:"target",sourceGeneration:"generation",targetGeneration:"generation",verb:"send_to_instance" as const,origin:{kind:"unknown" as const,people:[],receiptIds:[],chain:[]},message:"Synthetic legacy request",correlationId:randomUUID(),resultRecipient:"source",payload:{type:"fleet_inbound",content:"Synthetic legacy request"}};
 const ticket=box.contactAuthorizations.hold(request),admin={platform:"host" as const,adapterId:"host",userId:"operator",label:"Demo operator"};
 const decide=()=>box.contactAuthorizations.decide(ticket.id,{revision:ticket.revision,decision:"approve-once"},admin,{canDecide:()=>true,current:()=>true,admit:(req,id)=>fm.contactService().host.admit(req,id)});
 return {fm,box,ticket,decide};
}
it.each(["daemon","exec"])("a legacy decision cannot publish an unmapped delivery into a C-bound %s target",lane=>{
 const f=rig();if(lane==="daemon")f.fm.daemons.set("target",{requestContextCallsRequired:()=>true});else f.fm.fleetWindowsRuntime={requestContextCallsRequired:()=>true};
 expect(()=>f.decide()).toThrow(/legacy-decision-upgrade-required/);expect(f.box.listPending()).toEqual([]);expect(f.box.contactAuthorizations.get(f.ticket.id)).toMatchObject({state:"pending",revision:f.ticket.revision});expect(f.fm.scheduleDeliveryOutboxPump).not.toHaveBeenCalled();
});
it("an unbound legacy target retains the existing exact one-time admission lane",()=>{
 const f=rig(),decided=f.decide();expect(decided.deliveryId).toBeTruthy();expect(f.box.listPending()).toHaveLength(1);expect(f.box.requestContextForDelivery(decided.deliveryId!)).toBeNull();
});
