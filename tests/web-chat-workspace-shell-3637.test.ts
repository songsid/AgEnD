import { describe, expect, it } from "vitest";
import { serveAppShell } from "../src/web-api.js";
import { WebSessionStore, tokenEpoch } from "../src/web-session.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
const token = "a".repeat(48);
function shell({ user = "one", fleetToken = token, gateway = false, tier = "admin", mode = "full" }: {
  user?: string; fleetToken?: string; gateway?: boolean; tier?: "admin" | "read" | "guest"; mode?: "full" | "view-only";
} = {}) {
  const sessions = new WebSessionStore();
  const session = sessions.create({ tier, surface: gateway ? "gateway" : "local", ...(gateway ? { exposureId: "fixture" } : {}),
    label: "fixture", owner: { adapterId: "discord", userId: user }, tokenEpoch: tokenEpoch(fleetToken) });
  const req = { method: "GET", url: "/ui/chat/alpha", headers: { host: "127.0.0.1:19280", cookie: `${gateway ? "__Host-agend_session" : "agend_session"}=${session.sessionId}` }, socket: { remoteAddress: "127.0.0.1" } } as any;
  if (gateway) bindGatewayRequest(req, { surface: "gateway", exposureId: "fixture", expectedOrigin: "http://127.0.0.1:19280", isCurrent: () => true });
  let html = "";
  serveAppShell(req, { setHeader() {}, writeHead() {}, end(value: string) { html = value; } } as never, { webToken: fleetToken, webSessions: sessions }, mode);
  return /<body[^>]*>/.exec(html)?.[0] || "";
}
const scope = (html: string) => /data-chat-layout-scope="([a-f0-9]{64})"/.exec(html)?.[1];
describe("split-view marks carry convenience, never account or session authority", () => {
  it("uses a stable opaque per-person/per-fleet scope across fresh sessions", () => {
    const a = shell(), b = shell(); expect(a).toContain('data-chat-workspace="1"');
    expect(scope(a)).toHaveLength(64); expect(scope(a)).toBe(scope(b));
    expect(scope(a)).not.toBe(scope(shell({ user: "two" })));
    expect(scope(a)).not.toBe(scope(shell({ fleetToken: "b".repeat(48) })));
    expect(a).not.toContain('discord:one'); expect(a).not.toContain(token);
  });
  it.each([{ gateway: true }, { tier: "guest" as const }, { mode: "view-only" as const }])("never offers it on an excluded shell: %j", opts => {
    const html = shell(opts); expect(html).not.toContain("data-chat-workspace"); expect(scope(html)).toBeUndefined();
  });
  it("a read-only viewer gets only the same display convenience; server role policy is unchanged", () => {
    const html = shell({ tier: "read" }); expect(html).toContain('data-chat-workspace="1"'); expect(scope(html)).toHaveLength(64);
  });
});
