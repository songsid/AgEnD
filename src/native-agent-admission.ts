/** Preserve an authenticated native capability through the existing dispatcher mutation boundaries. */
import type { AgentEndpointContext } from "./agent-endpoint.js";
import type { RequestContextCallLease } from "./request-context-call.js";
export function nativeAgentAdmissionContext(ctx: AgentEndpointContext, input: {
  instance: string;
  current(): boolean;
  taskAllowed(args: Record<string, unknown>): boolean;
  requestContext?: RequestContextCallLease;
  notCoveredReason?: "interrupted-launch" | "unbound-input";
}): AgentEndpointContext {
  if (input.requestContext && input.notCoveredReason) throw Error("Conflicting originating-call coverage");
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
  const assert = (): void => { if (!input.current() || input.requestContext && !input.requestContext.current()) throw Error("Native MCP capability or tool access was revoked before admission"); };
  return new Proxy(ctx, {
    get: (target, key) => {
      const value = Reflect.get(target, key, target);
      if ((key === "hubReport" || key === "hubReact") && typeof value === "function") return (...args: unknown[]) => {
        assert();
        if (!object(args[0])) throw Error("Invalid scoped Hub operation");
        const original = args[0], previous = original.callerCurrent;
        return Reflect.apply(value, target, [{ ...original, callerCurrent: () => input.current()
          && (!input.requestContext || input.requestContext.current()) && (typeof previous !== "function" || previous()) }, ...args.slice(1)]);
      };
      if (key === "admitDurableDelivery" && typeof value === "function") return (...args: unknown[]) => {
        assert();
        if (!object(args[0]) || args[0].sourceInstance !== input.instance) throw Error("Native MCP delivery source does not match its capability");
        const admitted = input.requestContext || input.notCoveredReason ? [{ ...args[0], ...(input.requestContext ? { requestContextSnapshot: input.requestContext.snapshot } : { requestContextUncoveredReason: input.notCoveredReason }) }, ...args.slice(1)] : args;
        return Reflect.apply(value, target, admitted);
      };
      if (key === "handleTaskCrudHttp" && typeof value === "function") return (...args: unknown[]) => {
        assert();
        if (args[0] !== input.instance || !object(args[1]) || !input.taskAllowed(args[1])) throw Error("Native MCP task access was revoked before admission");
        return Reflect.apply(value, target, input.requestContext ? [...args, input.requestContext.snapshot] : input.notCoveredReason ? [...args, { coverage: "not-covered", reason: input.notCoveredReason }] : args);
      };
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
