/** Listener-owned provenance. HTTP headers can never select a public surface. */
export interface GatewayRequestContext {
  readonly surface: "gateway";
  /**
   * #2453 (§0.2): the admin's own named tunnel — this gateway was made with the named settings and the host it pinned is
   * exactly the configured hostname (absent: not). Never a quick tunnel; no header sets or changes it.
   */
  readonly named?: boolean;
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
