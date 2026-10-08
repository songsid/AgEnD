/** Listener-owned provenance. HTTP headers can never select a public surface. */
export interface GatewayRequestContext {
  readonly surface: "gateway";
  readonly exposureId: string;
  readonly expectedOrigin: string;
  readonly isCurrent: () => boolean;
}
const contexts = new WeakMap<object, GatewayRequestContext>();
export function bindGatewayRequest(req: object, context: GatewayRequestContext): void {
  if (contexts.has(req)) throw new Error("request context already bound");
  contexts.set(req, Object.freeze({ ...context }));
}
export function gatewayRequestContext(req: object): GatewayRequestContext | undefined {
  return contexts.get(req);
}
export function isWebRequestCurrent(req: object): boolean {
  return contexts.get(req)?.isCurrent() ?? true;
}
