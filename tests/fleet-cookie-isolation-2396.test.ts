import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { cookieListener, cookieRequest, HostCookieJar } from "./helpers/web-cookie-listener.js";
import { fleetCookieName } from "../src/web-cookie-names.js";
import { buildSessionCookie, readSessionCookies, sessionCookieUpgrade, buildClearedSessionCookies, authorizeSession } from "../src/web-auth.js";
import { buildDeviceCookie, readDeviceCookies } from "../src/web-returning-device.js";
import { tokenEpoch, csrfTokenFor } from "../src/web-session.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { buildSetupCookie } from "../src/setup-auth.js";
const roots: string[] = [], listeners: Awaited<ReturnType<typeof cookieListener>>[] = [];
async function start() { const root = mkdtempSync(join(tmpdir(), "agend-cookie-2396-")); roots.push(root); const h = await cookieListener(root); listeners.push(h); return h; }
afterEach(async () => { for (const h of listeners.splice(0)) await h.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it("two real listeners on one host keep both sign-ins in one port-independent cookie jar", async () => {
  const a = await start(), b = await start(), jar = new HostCookieJar();
  expect(a.port).not.toBe(b.port);
  expect((await cookieRequest(a, jar, "/auth/login", "POST", { code: a.issue() })).status).toBe(200);
  expect((await cookieRequest(a, jar, "/auth/session")).status).toBe(200);
  expect((await cookieRequest(b, jar, "/auth/login", "POST", { code: b.issue() })).status).toBe(200);
  expect((await cookieRequest(b, jar, "/auth/session")).status).toBe(200);
  expect((await cookieRequest(a, jar, "/auth/session")).status).toBe(200);
});
it("migrates only an owned legacy session, without changing its id, expiry or CSRF", async () => {
  const a = await start(), b = await start(), jar = new HostCookieJar();
  const legacy = a.sessions.create({ tier: "admin", surface: "local", label: "legacy", tokenEpoch: tokenEpoch(a.token) });
  jar.put(a.origin, [buildSessionCookie(legacy.sessionId, false, 3600)]);
  expect((await cookieRequest(b, jar, "/auth/session")).status).toBe(401);
  const upgraded = await cookieRequest(a, jar, "/auth/session");
  expect(upgraded.status).toBe(200);
  expect(upgraded.body.expiresAt).toBe(legacy.record.absoluteExpiry);
  expect(upgraded.body.csrf).toBe(csrfTokenFor(legacy.sessionId));
  expect(upgraded.cookies).toHaveLength(1);
  expect(upgraded.cookies[0]).toContain(`${fleetCookieName("agend_session", a.token)}=${legacy.sessionId};`);
  expect(upgraded.cookies[0]).not.toContain("Max-Age=0");
  expect(jar.header(a.origin + "/")).toContain(`agend_session=${legacy.sessionId}`); // Do not clear a shared slot during migration.
  expect((await cookieRequest(a, jar, "/auth/session")).cookies).toEqual([]);
});
it.each(["/auth/logout", "/auth/sessions"])("%s clears current and legacy session names without signing another fleet out", async path => {
  const a = await start(), b = await start(), jar = new HostCookieJar();
  await cookieRequest(a, jar, "/auth/login", "POST", { code: a.issue() });
  await cookieRequest(b, jar, "/auth/login", "POST", { code: b.issue() });
  const auth = await cookieRequest(a, jar, "/auth/session");
  const result = await cookieRequest(a, jar, path, path === "/auth/logout" ? "POST" : "DELETE", undefined, { "x-agend-csrf": auth.body.csrf });
  expect(result.status).toBe(200);
  expect(result.cookies.map(c => c.split("=")[0])).toEqual([fleetCookieName("agend_session", a.token), fleetCookieName("__Host-agend_session", a.token), "agend_session", "__Host-agend_session"]);
  expect(result.cookies.every(c => c.includes("Max-Age=0"))).toBe(true);
  expect((await cookieRequest(a, jar, "/auth/session")).status).toBe(401);
  expect((await cookieRequest(b, jar, "/auth/session")).status).toBe(200);
});
it("rejects cross-fleet ids even when renamed to the expected current or legacy name", async () => {
  const a = await start(), b = await start();
  b.sessions.create({ tier: "admin", surface: "local", label: "valid B control", tokenEpoch: tokenEpoch(b.token) });
  const session = a.sessions.create({ tier: "admin", surface: "local", label: "fleet A", tokenEpoch: tokenEpoch(a.token) });
  for (const name of [fleetCookieName("agend_session", a.token), fleetCookieName("agend_session", b.token), "agend_session", "__Host-agend_session"]) {
    const jar = new HostCookieJar(); jar.put(b.origin, [`${name}=${session.sessionId}; Path=/`]);
    const result = await cookieRequest(b, jar, "/auth/session");
    expect(result.status).toBe(401); expect(result.cookies).toEqual([]);
  }
});
it("sign-out leaves a foreign legacy shared slot intact until its owning fleet migrates it", async () => {
  const a = await start(), b = await start(), jar = new HostCookieJar();
  await cookieRequest(a, jar, "/auth/login", "POST", { code: a.issue() });
  const oldB = b.sessions.create({ tier: "admin", surface: "local", label: "unmigrated B", tokenEpoch: tokenEpoch(b.token) });
  jar.put(b.origin, [buildSessionCookie(oldB.sessionId, false, 3600)]);
  const auth = await cookieRequest(a, jar, "/auth/session");
  const out = await cookieRequest(a, jar, "/auth/logout", "POST", undefined, { "x-agend-csrf": auth.body.csrf });
  expect(out.status).toBe(200);
  expect(out.cookies.some(c => c.startsWith("agend_session="))).toBe(false);
  expect((await cookieRequest(b, jar, "/auth/session")).status).toBe(200);
  expect((await cookieRequest(a, jar, "/auth/session")).status).toBe(401);
});
it("keeps returning devices for both fleets and migrates an owned legacy device only", async () => {
  const a = await start(), b = await start(), jar = new HostCookieJar();
  const owner = { adapterId: "test", userId: "person", chatId: "private" };
  await cookieRequest(a, jar, "/auth/login", "POST", { code: a.issue(owner) });
  await cookieRequest(b, jar, "/auth/login", "POST", { code: b.issue(owner) });
  expect((await cookieRequest(a, jar, "/auth/device")).body.returning).toBe(true);
  expect((await cookieRequest(b, jar, "/auth/device")).body.returning).toBe(true);
  const legacy = a.devices.remember(owner, { surface: "local", label: "old", tokenEpoch: tokenEpoch(a.token), webToken: a.token });
  const oldJar = new HostCookieJar(); oldJar.put(a.origin, [buildDeviceCookie(legacy, false)]);
  expect((await cookieRequest(b, oldJar, "/auth/device")).body.returning).toBe(false);
  const upgraded = await cookieRequest(a, oldJar, "/auth/device");
  expect(upgraded.body.returning).toBe(true);
  expect(upgraded.cookies).toHaveLength(1);
  expect(upgraded.cookies[0]).toContain(`${fleetCookieName("agend_device", a.token)}=${legacy};`);
});
it("uses the persisted fleet key across listener reconstruction and port moves", async () => {
  const a = await start(), jar = new HostCookieJar();
  const login = await cookieRequest(a, jar, "/auth/login", "POST", { code: a.issue() });
  const dir = roots[roots.length - 1]!;
  const moved = await cookieListener(dir); listeners.push(moved);
  expect(moved.port).not.toBe(a.port); expect(moved.token).toBe(a.token);
  expect((await cookieRequest(moved, jar, "/auth/session")).status).toBe(200);
  expect(login.cookies[0]?.split("=")[0]).toBe(fleetCookieName("agend_session", moved.token));
});
it("keeps secure names __Host scoped, gateway reads secure-only, and namespaces setup too", async () => {
  const a = await start(), b = await start();
  for (const cookie of [buildSessionCookie("id", true, 60, a.token), buildDeviceCookie("id", true, a.token)]) {
    expect(cookie.startsWith("__Host-agend_")).toBe(true); expect(cookie).toContain("; Secure"); expect(cookie).toContain("Path=/"); expect(cookie).not.toContain("Domain=");
  }
  expect(buildSetupCookie("secret", { path: "/s/one/", secure: true, maxAgeSeconds: 60, webToken: a.token })).toContain(fleetCookieName("agend_setup", a.token));
  expect(fleetCookieName("agend_setup", a.token)).not.toBe(fleetCookieName("agend_setup", b.token));
  const req: any = { method: "GET", headers: { cookie: `${fleetCookieName("agend_session", a.token)}=plain; agend_session=legacy-plain; ${fleetCookieName("__Host-agend_session", a.token)}=secure; __Host-agend_session=legacy-secure` } };
  bindGatewayRequest(req, { surface: "gateway", exposureId: "current", expectedOrigin: "https://public.example.com", isCurrent: () => true });
  expect(readSessionCookies(req, a.token)).toEqual(["secure", "legacy-secure"]);
  expect(readDeviceCookies(`agend_device=plain; __Host-agend_device=secure`, true, a.token)).toEqual(["secure"]);
  expect(buildClearedSessionCookies(a.token).filter(c => c.startsWith("__Host-")).every(c => c.endsWith("; Secure"))).toBe(true);
});
it("does not upgrade revoked or foreign records through a public request", async () => {
  const a = await start();
  const old = a.sessions.create({ tier: "admin", surface: "gateway", label: "old", tokenEpoch: tokenEpoch(a.token), exposureId: "old" });
  const req: any = { method: "GET", headers: { cookie: `__Host-agend_session=${old.sessionId}` } };
  bindGatewayRequest(req, { surface: "gateway", exposureId: "new", expectedOrigin: "https://public.example.com", isCurrent: () => true });
  expect(authorizeSession(req, a.token, a.sessions).kind).toBe("reject");
  const closed: any = { method: "GET", headers: req.headers };
  bindGatewayRequest(closed, { surface: "gateway", exposureId: "old", expectedOrigin: "https://public.example.com", isCurrent: () => false });
  expect(sessionCookieUpgrade(closed, a.token, old.record)).toBeNull();
});
it.each(["admin", "guest"] as const)("migrates an owned public %s session with Secure attributes and rejects a plain-cookie downgrade", async tier => {
  const a = await start();
  const own = a.sessions.create({ tier, surface: "gateway", exposureId: "current", label: "public", tokenEpoch: tokenEpoch(a.token), ...(tier === "guest" ? { owner: { adapterId: "test", userId: "guest" } } : {}) });
  const request = (cookie: string) => {
    const req = { method: "GET", headers: { cookie } };
    bindGatewayRequest(req, { surface: "gateway", exposureId: "current", expectedOrigin: "https://public.example.com", isCurrent: () => true });
    return req;
  };
  const legacy = request(`__Host-agend_session=${own.sessionId}`);
  expect(authorizeSession(legacy, a.token, a.sessions).kind).toBe("ok");
  const upgraded = sessionCookieUpgrade(legacy, a.token, own.record)!;
  expect(upgraded).toContain(`${fleetCookieName("__Host-agend_session", a.token)}=${own.sessionId};`);
  expect(upgraded).toContain("; Secure"); expect(upgraded).not.toContain("Domain=");
  expect(authorizeSession(request(upgraded.split(";")[0]!), a.token, a.sessions).kind).toBe("ok");
  expect(authorizeSession(request(`${fleetCookieName("agend_session", a.token)}=${own.sessionId}`), a.token, a.sessions).kind).toBe("reject");
});
