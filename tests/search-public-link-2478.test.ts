/**
 * #2478 item 3 (the user's request): global search over the temporary public link for an admin session, by default.
 * web.search.public_link: false keeps it off there — the app shell then says data-search-link="0" (no entry, no
 * shortcut) and the route refuses it. The route's own rules are in search-web-2293.test.ts; this is the page's marker.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { serveAppShell } from "../src/web-api.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { validateFleetConfig } from "../src/config-validator.js";

function body(gateway: boolean, web?: Record<string, unknown>): string {
  const req: any = Object.assign(new EventEmitter(), { method: "GET", url: "/ui", headers: { host: gateway ? "x.trycloudflare.com" : "127.0.0.1:19280" } });
  if (gateway) bindGatewayRequest(req, { surface: "gateway", exposureId: "e1", expectedOrigin: "https://x.trycloudflare.com", isCurrent: () => true });
  let html = "";
  const res: any = { setHeader() {}, writeHead() {}, end(t: string) { html = t; } };
  serveAppShell(req, res, { ...(web ? { fleetConfig: { instances: {}, web } } : {}) } as never, "full");
  return /<body[^>]*>/.exec(html)?.[0] ?? "";
}

describe("#2478: the app shell's search marker on the public link", () => {
  it("offered by default: no data-search-link anywhere; public_link: false marks the public link's page only", () => {
    const marked = (b: string) => /data-search-link="0"/.test(b);
    expect([marked(body(true)), marked(body(true, { search: {} })), marked(body(true, { search: { public_link: true } }))]).toEqual([false, false, false]);
    expect([marked(body(true, { search: { public_link: false } })), marked(body(false, { search: { public_link: false } }))]).toEqual([true, false]);
    expect(body(true)).toMatch(/data-public-link="1"/);
  });
  it("config: web.search.public_link is a boolean, a known key", () => {
    const check = (search: unknown) => validateFleetConfig({ instances: {}, web: { search } } as never);
    const ok = check({ public_link: false });
    expect([ok.errors.filter((e: any) => /web\.search/.test(e.path ?? e)).length, ok.warnings.filter((w: any) => /web\.search/.test(w.path ?? w)).length]).toEqual([0, 0]);
    expect(check({ public_link: "no" }).errors.some((e: any) => /web\.search\.public_link/.test(JSON.stringify(e)))).toBe(true);
  });
});
