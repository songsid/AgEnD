/** Real lifecycle queue and epochs; inert daemon only, no process/tmux/Fleet start. */
import {afterEach,expect,it,vi} from "vitest";
import {InstanceLifecycle} from "../src/instance-lifecycle.js";
import {SettingsRouteLifetime} from "../src/settings-route-lifetime.js";
import {SettingsExecution} from "../src/settings-transaction.js";
const executions:SettingsExecution[]=[];
afterEach(()=>{for(const execution of executions.splice(0))execution.close();});
function rig(){
 const stopping=new Set<string>(),daemon={stop:vi.fn(async()=>{})};let allowed=true;
 const lifecycle=new InstanceLifecycle({setTopicIcon:vi.fn(),ipcStoppingInstances:stopping,instanceIpcClients:new Map(),sessionRegistry:new Map()} as any);
 lifecycle.daemons.set("general",daemon as any);
 const route=new SettingsRouteLifetime("general",()=>allowed,()=>lifecycle.epochOf("general"),()=>stopping.has("general"));
 const other=new SettingsRouteLifetime("general",()=>allowed,()=>lifecycle.epochOf("general"),()=>stopping.has("general"));
 const execution=new SettingsExecution({current:route.current,snapshot:()=>"same settings",followStop:route.followStop.bind(route)});executions.push(execution);
 return{lifecycle,daemon,route,other,execution,revoke:()=>{allowed=false;}};
}
function gate(){let release!:()=>void;const wait=new Promise<void>(resolve=>{release=resolve;});return{wait,release};}
it("follows both real owned stop invalidations while every other card stays stale",async()=>{
 const r=rig();
 await r.execution.stopTarget("general",advance=>r.lifecycle.stopIfCurrent("general",r.daemon,advance));
 expect(r.lifecycle.epochOf("general")).toBe(2);expect(r.daemon.stop).toHaveBeenCalledOnce();
 expect(r.lifecycle.daemons.has("general")).toBe(false);expect(r.route.current()).toBe(true);expect(r.execution.current()).toBe(true);expect(r.other.current()).toBe(false);
});
it("retains the immediate publication fence and the owned queued stop boundary",async()=>{
 const r=rig(),held=gate();const prior=r.lifecycle.runTransition("general",()=>held.wait);await Promise.resolve();
 const stopped=r.execution.stopTarget("general",advance=>r.lifecycle.stopIfCurrent("general",r.daemon,advance));
 expect(r.lifecycle.epochOf("general")).toBe(1);expect(r.route.current()).toBe(true);expect(r.daemon.stop).not.toHaveBeenCalled();
 held.release();await prior;await stopped;expect(r.lifecycle.epochOf("general")).toBe(2);expect(r.route.current()).toBe(true);
});
it.each(["external invalidation","route revoked"])("refuses %s while an owned stop awaits forced-exit cleanup",async reason=>{
 const r=rig(),held=gate();r.daemon.stop.mockImplementation(async()=>{await held.wait;});
 const stopped=r.execution.stopTarget("general",advance=>r.lifecycle.stopIfCurrent("general",r.daemon,advance));
 const rejected=expect(stopped).rejects.toThrow(/superseded/);
 await vi.waitFor(()=>expect(r.daemon.stop).toHaveBeenCalledOnce());
 if(reason==="external invalidation")r.lifecycle.invalidate("general");else r.revoke();
 held.release();await rejected;expect(r.execution.current()).toBe(false);
});
it("cannot adopt an external invalidation between queue admission and its own transition",async()=>{
 const r=rig(),held=gate();const prior=r.lifecycle.runTransition("general",()=>held.wait);await Promise.resolve();
 const stopped=r.execution.stopTarget("general",advance=>r.lifecycle.stopIfCurrent("general",r.daemon,advance));
 const rejected=expect(stopped).rejects.toThrow(/superseded/);
 r.lifecycle.invalidate("general");held.release();await prior;await rejected;
 expect(r.daemon.stop).not.toHaveBeenCalled();expect(r.route.current()).toBe(false);
});
it("never stops or follows a replacement daemon",async()=>{
 const r=rig(),replacement={stop:vi.fn(async()=>{})};r.lifecycle.daemons.set("general",replacement as any);
 await expect(r.execution.stopTarget("general",advance=>r.lifecycle.stopIfCurrent("general",r.daemon,advance))).rejects.toThrow(/superseded/);
 expect(r.daemon.stop).not.toHaveBeenCalled();expect(replacement.stop).not.toHaveBeenCalled();expect(r.lifecycle.daemons.get("general")).toBe(replacement);
});
