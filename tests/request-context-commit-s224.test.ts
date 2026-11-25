import { it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { captureRequestContextCall } from "../src/request-context-call.js";
import { nativeAgentAdmissionContext } from "../src/native-agent-admission.js";
import type { RequestContextTurnSnapshot } from "../src/request-context-turns.js";
it("S-224 original-call admission guards delivery/task commit after an awaited stage, and preserves the exact snapshot",async()=>{
 const root=randomUUID(),snapshot:RequestContextTurnSnapshot={token:randomUUID(),inputId:"input-a",wireSha256:"a".repeat(64),owner:{instance:"worker",incarnation:"incarnation",workGeneration:"work",daemonBootId:"boot",spawnGeneration:1,launchFenceEpoch:0,deliveryEpoch:0},context:{ref:{version:1,contextId:root,rootContextId:root},rootEvidenceRef:"fixture",ingress:"guest",initiatingActor:{kind:"person",platform:"discord",userId:"demo-person"},source:{instance:"worker",incarnation:"incarnation"},sourceAudience:{kind:"web",ref:randomUUID()}}};
 let active=snapshot.token;const scope=captureRequestContextCall(snapshot,captured=>captured.token===active);
 const delivery=vi.fn((_input:any)=>({sent:true})),task=vi.fn(async()=>({ok:true})),hub=vi.fn((input:any)=>input);
 const ctx=nativeAgentAdmissionContext({admitDurableDelivery:delivery,handleTaskCrudHttp:task,hubReport:hub}as any,{instance:"worker",current:()=>true,taskAllowed:()=>true,requestContext:scope});
 (ctx.admitDurableDelivery as any)({sourceInstance:"worker"});expect(delivery.mock.calls[0][0]).toMatchObject({requestContextSnapshot:scope.snapshot});
 await ctx.handleTaskCrudHttp("worker",{action:"create"});expect(task).toHaveBeenCalledWith("worker",{action:"create"},scope.snapshot);
 const bound=(ctx.hubReport as any)({callerCurrent:()=>true});expect(bound.callerCurrent()).toBe(true);
 let release!:()=>void;const stage=new Promise<void>(done=>{release=done;});
 const pending=(async()=>{await stage;expect(()=>(ctx.admitDurableDelivery as any)({sourceInstance:"worker"})).toThrow(/revoked/);expect(()=>ctx.handleTaskCrudHttp("worker",{action:"create"})).toThrow(/revoked/);})();
 active=randomUUID();release();await pending;expect(delivery).toHaveBeenCalledOnce();expect(task).toHaveBeenCalledOnce();expect(bound.callerCurrent()).toBe(false);
});
