/** Two-listener auth harness: real HTTP/auth/session stores; no FleetManager, CLI, adapter or tmux. */
import { createServer } from "node:http";
import { loadOrCreateWebToken } from "../../src/web-auth.js";
import { handleAuthRequest, type AuthApiContext } from "../../src/auth-api.js";
import { WebSessionStore, tokenEpoch } from "../../src/web-session.js";
import { WebLoginCodes, type LoginCodeOwner } from "../../src/web-login.js";
import { ReturningDevices } from "../../src/web-returning-device.js";

export async function cookieListener(dataDir: string) {
  const token = loadOrCreateWebToken(dataDir), sessions = new WebSessionStore({ dataDir }), codes = new WebLoginCodes();
  const devices = new ReturningDevices({ dataDir });
  const quiet = () => {};
  const ctx = {
    webToken: token, webSessions: sessions, webLoginCodes: codes,
    logger: { info: quiet, debug: quiet, warn: quiet, error: quiet },
    rememberReturningDevice: (owner: LoginCodeOwner, input: { surface: "local" | "gateway"; label: string }) => devices.remember(owner, { ...input, tokenEpoch: tokenEpoch(token), webToken: token }),
    verifyReturningDevice: (value: string | undefined) => devices.verify(value, token, tokenEpoch(token)),
  } as unknown as AuthApiContext;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/probe") { res.writeHead(200, { "Content-Type": "text/html" }); res.end("<!doctype html><title>Private cookie probe</title>"); return; }
    if (!handleAuthRequest(req, res, url, ctx)) { res.writeHead(404); res.end(); }
  });
  await new Promise<void>((done, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", () => { server.removeListener("error", fail); done(); }); });
  const port = (server.address() as { port: number }).port, origin = `http://127.0.0.1:${port}`;
  return { token, sessions, devices, codes, ctx, server, port, origin,
    issue(owner?: LoginCodeOwner) { return codes.issue({ epoch: tokenEpoch(token), ...(owner ? { owner } : {}) }).display; },
    async close() { sessions.flush(); await new Promise<void>(done => server.close(() => done())); },
  };
}

/** Host-only RFC cookie storage deliberately ignores URL ports (as browsers do). */
export class HostCookieJar {
  readonly entries = new Map<string, { host: string; name: string; value: string; path: string; secure: boolean }>();
  put(origin: string, headers: string[]) {
    const host = new URL(origin).hostname;
    for (const header of headers) {
      const [pair, ...attrs] = header.split(";"); const eq = pair!.indexOf("=");
      const name = pair!.slice(0, eq), value = pair!.slice(eq + 1);
      const path = attrs.find(a => a.trim().toLowerCase().startsWith("path="))?.trim().slice(5) ?? "/";
      const key = `${host}\0${path}\0${name}`;
      if (attrs.some(a => a.trim().toLowerCase() === "max-age=0")) this.entries.delete(key);
      else this.entries.set(key, { host, name, value, path, secure: attrs.some(a => a.trim().toLowerCase() === "secure") });
    }
  }
  header(url: string): string {
    const u = new URL(url);
    return [...this.entries.values()].filter(c => c.host === u.hostname && u.pathname.startsWith(c.path) && (!c.secure || u.protocol === "https:")).map(c => `${c.name}=${c.value}`).join("; ");
  }
}
export async function cookieRequest(h: Awaited<ReturnType<typeof cookieListener>>, jar: HostCookieJar, path: string, method = "GET", body?: unknown, extra: Record<string, string> = {}) {
  const url = h.origin + path;
  const r = await fetch(url, { method, headers: { cookie: jar.header(url), ...(method !== "GET" ? { origin: h.origin, "content-type": "application/json" } : {}), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const cookies = r.headers.getSetCookie(); jar.put(h.origin, cookies);
  return { status: r.status, body: await r.json(), cookies };
}
