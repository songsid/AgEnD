import {captureRequestHubOutput} from "./request-hub-output.js";
import {requireRequestContextPolicy} from "./request-context-policy.js";
import type {RequestContextCallAdmission} from "./request-context-call.js";
/** Preserve an authenticated native capability through the existing dispatcher mutation boundaries. */
import type { AgentEndpointContext } from "./agent-endpoint.js";
import type { RequestContextCallLease } from "./request-context-call.js";
export function nativeAgentAdmissionContext(ctx: AgentEndpointContext, input: {
  instance: string;
  current(): boolean;
  taskAllowed(args: Record<string, unknown>): boolean;
  requestContext?: RequestContextCallLease;
  notCoveredReason?: "interrupted-launch" | "unbound-input";
  operation?:{tool:string;args:Record<string,unknown>};
}): AgentEndpointContext {
  if (input.requestContext && input.notCoveredReason) throw Error("Conflicting originating-call coverage");
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
  const assert = (): void => { if (!input.current() || input.requestContext && !input.requestContext.current()) throw Error("Native MCP capability or tool access was revoked before admission"); };
  const admission:RequestContextCallAdmission|undefined=input.requestContext?{coverage:"covered",lease:input.requestContext}:input.notCoveredReason?{coverage:"not-covered",reason:input.notCoveredReason}:undefined;
  const operation=input.operation?structuredClone(input.operation):undefined;
  const policy=(tool:string,args:Record<string,unknown>):void=>{if(ctx.requestContextPolicy)requireRequestContextPolicy(ctx,input.instance,tool,args,admission);};
  return new Proxy(ctx, {
    get: (target, key) => {
      if(key==="requestContextCallAdmission")return admission;
      const value = Reflect.get(target, key, target);
      if ((key === "hubReport" || key === "hubReact") && typeof value === "function") return (...args: unknown[]) => {
        assert();
        if (!object(args[0])) throw Error("Invalid scoped Hub operation");
        const original = args[0], previous = original.callerCurrent;
        const requestScope=ctx.requestContextPolicy?captureRequestHubOutput(admission):undefined;
        return Reflect.apply(value, target, [{ ...original, ...(requestScope?{requestScope}:{}), callerCurrent: () => input.current()
          && (!input.requestContext || input.requestContext.current()) && (typeof previous !== "function" || previous()) }, ...args.slice(1)]);
      };
      if(ctx.requestContextPolicy&&key==="hubRoomHistory"&&typeof value==="function")return (...args:unknown[])=>{
        assert();policy("hub_room_history",{...(object(args[2])?args[2]:{}),room:args[1]});
        if(!object(args[0])||args[0].agent!==input.instance)throw Error("Invalid scoped Hub caller");
        const previous=args[0].current;
        return Reflect.apply(value,target,[{...args[0],requestScope:captureRequestHubOutput(admission),current:()=>input.current()&&(!input.requestContext||input.requestContext.current())&&(typeof previous!=="function"||previous())},...args.slice(1)]);
      };
      if(ctx.requestContextPolicy&&key==="hubRoomPost"&&typeof value==="function")return (...args:unknown[])=>{assert();policy("hub_room_post",object(args[1])?{...args[1],receiptId:args[1].receiptId}:{});if(!object(args[0])||args[0].agent!==input.instance)throw Error("Invalid scoped Hub caller");return Reflect.apply(value,target,[{...args[0],requestScope:captureRequestHubOutput(admission)},...args.slice(1)]);};
      if (key === "admitDurableDelivery" && typeof value === "function") return (...args: unknown[]) => {
        assert();
        const image=object(args[0])?args[0]:{};policy(operation?.tool??"unknown",{...operation?.args,forwards:image.forwards,requestedKind:image.requestedKind,kind:image.kind,meta:object(image.payload)?image.payload.meta:undefined});
        if (!object(args[0]) || args[0].sourceInstance !== input.instance) throw Error("Native MCP delivery source does not match its capability");
        if(ctx.requestContextRelay){
          if(!operation)throw Error("Canonical scoped operation is unavailable");
          return ctx.requestContextRelay.admit(args[0] as unknown as import("./request-context-relay.js").RequestRelayDelivery,{instance:input.instance,tool:operation.tool,args:operation.args,admission},input.current);
        }
        if(ctx.requestContextPolicy)throw Error("Request contact dispatcher is not installed; no legacy fallback");
        const admitted = input.requestContext || input.notCoveredReason ? [{ ...args[0], ...(input.requestContext ? { requestContextSnapshot: input.requestContext.snapshot } : { requestContextUncoveredReason: input.notCoveredReason }) }, ...args.slice(1)] : args;
        return Reflect.apply(value, target, admitted);
      };
      if (key === "handleTaskCrudHttp" && typeof value === "function") return (...args: unknown[]) => {
        assert();policy("task",object(args[1])?args[1]:{});
        if (args[0] !== input.instance || !object(args[1]) || !input.taskAllowed(args[1])) throw Error("Native MCP task access was revoked before admission");
        return Reflect.apply(value, target, input.requestContext ? [...args, input.requestContext.snapshot,...(ctx.requestContextPolicy?[admission]:[])] : input.notCoveredReason ? [...args, { coverage: "not-covered", reason: input.notCoveredReason },...(ctx.requestContextPolicy?[admission]:[])] : args);
      };
      if(ctx.requestContextPolicy&&key==="handleScheduleCrudHttp"&&typeof value==="function")return (...args:unknown[])=>{assert();policy(args[1]==="list"?"list_schedules":`${args[1]}_schedule`,object(args[2])?args[2]:{});return Reflect.apply(value,target,[...args,admission]);};
      if(ctx.requestContextPolicy&&key==="handleWebThemeHttp"&&typeof value==="function")return (...args:unknown[])=>{assert();policy(String(args[1]),object(args[2])?args[2]:{});return Reflect.apply(value,target,[...args,admission]);};
      if(ctx.requestContextPolicy&&key==="saveFleetConfig"&&typeof value==="function")return (...args:unknown[])=>{assert();policy(operation?.tool??"update_instance_config",operation?.args??{});return Reflect.apply(value,target,[args[0]??[],admission]);};
      // These owned mutators can be reached after an awaited preparation. Keep this call's lease, not a later turn.
      if(ctx.requestContextPolicy&&typeof value==="function"&&new Set(["startInstance","stopInstance","restartSingleInstance","explicitWake","requestWindowsCreate","requestWindowsConfig","switchClassicRoomProfile","setInstanceDescription","setPersonaEmoji","createTeam","deleteTeam","updateTeam"]).has(String(key)))return (...args:unknown[])=>{assert();policy(operation?.tool??String(key),operation?.args??{});return Reflect.apply(value,target,args);};
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
