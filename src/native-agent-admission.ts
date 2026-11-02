/** Preserve an authenticated native capability through the existing dispatcher mutation boundaries. */
import type { AgentEndpointContext } from "./agent-endpoint.js";
export function nativeAgentAdmissionContext(ctx: AgentEndpointContext, input: {
  instance: string;
  current(): boolean;
  taskAllowed(args: Record<string, unknown>): boolean;
}): AgentEndpointContext {
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
  const assert = (): void => { if (!input.current()) throw Error("Native MCP capability or tool access was revoked before admission"); };
  return new Proxy(ctx, {
    get: (target, key) => {
      const value = Reflect.get(target, key, target);
      if (key === "admitDurableDelivery" && typeof value === "function") return (...args: unknown[]) => {
        assert();
        if (!object(args[0]) || args[0].sourceInstance !== input.instance) throw Error("Native MCP delivery source does not match its capability");
        return Reflect.apply(value, target, args);
      };
      if (key === "handleTaskCrudHttp" && typeof value === "function") return (...args: unknown[]) => {
        assert();
        if (args[0] !== input.instance || !object(args[1]) || !input.taskAllowed(args[1])) throw Error("Native MCP task access was revoked before admission");
        return Reflect.apply(value, target, args);
      };
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
