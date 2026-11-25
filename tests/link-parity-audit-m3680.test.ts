/**
 * M-3680 part 3 — the link-parity audit (decision 7933bf90: an admin session has the same features on localhost, the
 * quick link and the fixed link; only technical limits remain). Two guards:
 *  1. Every route the dashboard's own code calls (src/ui, every string or template that starts /ui/, /api/ or /auth/) is
 *     on the public link's route list for some method — or named below with why not. A new dashboard route missing from
 *     the list fails here until someone decides (route it, or name the reason).
 *  2. Needs you's "Try again" on held Hub work (M-3632), the one admin route the audit found missing besides the contact
 *     routes (#4433): routed, an admin session's over the link, refused to a read-only session there.
 * Found but kept (each by its own earlier decision, listed for the user): Claude credentials stay on this computer
 * (credential_local_verified_required); the Hub host owner's setup surfaces (M-3278: "this computer only"); a web-only
 * fleet's outside switch and strict mode (#3008, host-only); a settings change that opens a link is never confirmed over
 * a link; the runtime installer files. PUT /ui/offices was reported as refused (M-3692) — it is not: on the list since
 * M-3278 and saved over the link in web-offices-api.test.ts; the comment that said otherwise is corrected.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { isPublicWebRoute } from "../src/public-web-gateway.js";
import { handleWebRequest } from "../src/web-api.js";
import { WebSessionStore, csrfTokenFor, tokenEpoch } from "../src/web-session.js";
import { bindGatewayRequest } from "../src/web-request-context.js";

/** Paths the sweep cannot settle by itself, or that stay off the link on purpose — each with why. */
const NAMED: Record<string, string> = {
  "/api/ai-usagex": "template `/api/ai-usage${…}` (a query): GET /api/ai-usage is routed",
  "/api/card/x/x": "/api/card/<name>/<portrait|banner>: routed (the sweep's ids are not slot names)",
  "/api/hub/member/pairing/x": "/api/hub/member/pairing/<connect|confirm|disconnect|cancel>: routed",
  "/api/settings": "a prefix the page builds paths from",
  "/api/settings/connections/x/binding": "base of …/binding/verify and …/binding/apply: routed",
  "/api/settings/connections/x/secret": "base of …/secret/verify and …/secret/apply: routed",
  "/api/settings/hub/directory": "the Hub host owner's surface: this computer only (M-3278)",
  "/api/settings/hub/member-address": "the Hub host owner's surface: this computer only (M-3278)",
  "/api/settings/hub/security-notices/directory": "the Hub host owner's surface: this computer only (M-3278)",
  "/api/settings/hub/setup": "the Hub host owner's surface: this computer only (M-3278)",
  "/api/settings/hub/web-address": "the Hub host owner's surface: this computer only (M-3278)",
  "/api/settings/hub/sharing-notices/x/undo": "…/sharing-notices/<64 hex>/undo: routed",
  "/api/settings/instances/x/x": "…/instances/<name>/<pause|wake>: routed",
  "/api/settings/secrets/x": "base of …/secrets/<id>/verify and …/apply: routed",
  "/auth": "a prefix",
  "/auth/device-loginx": "a new device's own sign-in; over the link it signs in with the authenticator's code (#3061)",
  "/ui/api/contact-authorizations${s ": "template with a query: GET /ui/api/contact-authorizations is routed (#4433)",
  "/ui/chat": "a page address (the shell)",
  "/ui/claude-credentials": "Claude credentials: this computer only, verified admin (credential_local_verified_required)",
  "/ui/claude-credentials/setup-token": "Claude credentials: this computer only, verified admin (credential_local_verified_required)",
  "/ui/devices/x": "/ui/devices/<lookup|approve|deny|signout>: routed",
  "/ui/file": "a prefix (/ui/file/<id> is routed)",
  "/ui/fleet/x": "a page address (the shell)",
  "/ui/hub/ai-apps": "a page on a Hub's own listener, not the Fleet dashboard",
  "/ui/img/emoji": "a prefix (/ui/img/emoji/<name> is routed)",
  "/ui/img/…": "an ellipsis in a comment",
  "/ui/js/x/fleet-route-worker.js": "/ui/js/v-<V>/… is checked as its plain path (M-3314): routed",
  "/ui/themes/x/x": "/ui/themes/<name>/<reset|lock|widget|ambient>: routed",
  "/ui/x/x": "a page address (the shell)",
};

function dashboardPaths(): Map<string, string> {
  const files: string[] = [];
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(js|mjs)$/.test(f)) files.push(p); } };
  walk("src/ui");
  const out = new Map<string, string>();
  const re = /`(\/(?:ui|api|auth)\/[^`]*)`|["'](\/(?:ui|api|auth)\/[A-Za-z0-9_\-./:%]*)["']/g;
  for (const f of files) for (const m of readFileSync(f, "utf8").matchAll(re)) {
    const p = (m[1] ?? m[2]!).replace(/\$\{[^}]*\}/g, "x").split("?")[0]!.replace(/\/+$/, "");
    if (p.length >= 4 && !out.has(p)) out.set(p, f);
  }
  return out;
}
const SAMPLES = ["dev", "0123456789abcdef0123456789abcdef", "0123abcd", "01234567-89ab-cdef-0123-456789abcdef", "R01234567-89ab-cdef-0123-456789abcdef", "claude-code", "a.png", "abc"];
function variants(p: string): string[] {
  if (!/(^|\/)[^/]*x(?=\/|$)/.test(p)) return [p];
  return SAMPLES.flatMap((v) => variants(p.replace(/(^|\/)([^/]*?)x(?=\/|$)/, (_m, a, pre) => `${a}${pre}${v}`))).slice(0, 400);
}
const routed = (p: string) => ["GET", "POST", "PUT", "PATCH", "DELETE"].some((m) => variants(p).some((v) => isPublicWebRoute(m, v)));

describe("1. every route the dashboard calls is on the public link's list, or named with why not", () => {
  it("no unnamed route is missing, and every name is still needed", () => {
    const paths = dashboardPaths();
    expect(paths.size).toBeGreaterThan(200);
    const missing = [...paths].filter(([p]) => !routed(p) && !(p in NAMED)).map(([p, f]) => `${p} (${f})`);
    expect(missing, "route these over the link (decision 7933bf90), or name why not").toEqual([]);
    const stale = Object.keys(NAMED).filter((p) => !paths.has(p) || routed(p));
    expect(stale, "a named path the dashboard no longer calls, or now routed: drop its name").toEqual([]);
  });
  it("the admin routes this audit settled, with their real methods and shapes", () => {
    const H = "0123456789abcdef0123456789abcdef";
    for (const [m, p] of [["GET", "/api/ai-usage"], ["POST", "/api/card/dev/portrait"], ["POST", "/api/hub/member/pairing/connect"], ["POST", "/api/settings/instances/dev/pause"],
      ["POST", "/api/settings/connections/main/secret/verify"], ["POST", "/api/settings/connections/main/binding/apply"], ["POST", "/ui/devices/lookup"], ["POST", "/ui/themes/dev/reset"],
      ["GET", "/ui/js/fleet-route-worker.js"], ["PUT", "/ui/offices"], ["PUT", "/ui/office-style"], ["POST", "/ui/schedules"], ["POST", "/ui/teams"], ["POST", "/ui/needs/hub-retry"],
      ["GET", "/ui/api/contact-authorizations"], ["POST", `/api/settings/hub/sharing-notices/${H}${H}/undo`]] as const) {
      expect([m, p, isPublicWebRoute(m, p)]).toEqual([m, p, true]);
    }
    // Kept on this computer on purpose (listed for the user): credentials and the Hub host owner's setup.
    for (const [m, p] of [["GET", "/ui/claude-credentials"], ["POST", "/ui/claude-credentials/setup-token"], ["GET", "/api/settings/hub/setup"], ["GET", "/api/settings/hub/web-address"]] as const) {
      expect([m, p, isPublicWebRoute(m, p)]).toEqual([m, p, false]);
    }
  });
});

describe("2. Needs you's Try again on held Hub work over the link", () => {
  const TOKEN = "e".repeat(48);
  function call(opts: { local?: boolean; tier?: "admin" | "read" }, retry: (id: string) => unknown) {
    const sessions = new WebSessionStore(), exposureId = "a".repeat(32), pub = "https://sample.trycloudflare.com", local = "http://127.0.0.1:19280";
    const s = sessions.create({ tier: opts.tier ?? "admin", surface: opts.local ? "local" : "gateway", exposureId: opts.local ? undefined : exposureId, label: "t", tokenEpoch: tokenEpoch(TOKEN) } as never);
    const origin = opts.local ? local : pub;
    const headers: Record<string, string> = { host: new URL(origin).host, cookie: `${opts.local ? "" : "__Host-"}agend_session=${s.sessionId}`, origin, "sec-fetch-site": "same-origin",
      "x-agend-csrf": csrfTokenFor(s.sessionId), "content-type": "application/json" };
    return new Promise<{ status: number; body: any }>((resolve) => {
      const req = Object.assign(new EventEmitter(), { method: "POST", url: "/ui/needs/hub-retry", headers, destroy: vi.fn() });
      if (!opts.local) bindGatewayRequest(req as never, { surface: "gateway", exposureId, expectedOrigin: pub, isCurrent: () => true });
      let status = 0;
      const res = Object.assign(new EventEmitter(), { headersSent: false, destroyed: false, setHeader() {}, writeHead: (c: number) => { status = c; },
        end: (t = "") => resolve({ status, body: t ? JSON.parse(String(t)) : null }) });
      handleWebRequest(req as never, res as never, new URL("/ui/needs/hub-retry", origin), { webToken: TOKEN, webSessions: sessions, fleetConfig: { defaults: {}, instances: {} },
        logger: { debug() {}, info() {}, warn() {}, error() {} }, getUiStatus: () => ({ instances: [] }), listWebPrompts: () => [], needsYouItems: () => [], retryHubHeld: retry } as never);
      req.emit("data", Buffer.from(JSON.stringify({ id: "hub:hold:1" }))); req.emit("end");
    });
  }
  it("an admin over the link retries it; a read-only session there is refused before anything runs; the local page as before", async () => {
    const retry = vi.fn(() => ({ status: 200, code: "queued" }));
    expect((await call({}, retry))).toEqual({ status: 200, body: { ok: true, code: "queued" } });
    expect(retry).toHaveBeenCalledWith("hub:hold:1");
    retry.mockClear();
    expect((await call({ tier: "read" }, retry)).status).toBe(403);
    expect(retry).not.toHaveBeenCalled();
    expect((await call({ local: true }, retry)).status).toBe(200);
  });
});
