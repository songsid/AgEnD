import { describe, expect, it } from "vitest";
import { handleAuthRequest } from "../src/auth-api.js";

function entry(path: string, method = "GET", available = true) {
  const req = { method, headers: {}, socket: {} };
  let status = 0, body = "";
  const res = { setHeader() {}, writeHead(s: number) { status = s; }, end(s?: string) { body = s ?? ""; } };
  const ctx = { totpSignIn: available ? () => { throw Error("Rendering must not authenticate"); } : undefined, isWebOnlyFleet: () => true };
  const handled = handleAuthRequest(req as any, res as any, new URL(path, "http://localhost"), ctx as any);
  return { handled, status, body };
}
describe("S-118 replaces the temporary authenticator entry, without changing authentication", () => {
  it.each(["/signin", "/signin/authenticator"])("%s serves the same single-box shell without account names", path => {
    const r = entry(path);
    expect(r.handled).toBe(true); expect(r.status).toBe(200);
    expect(r.body).toContain('src="/assets/signin.js"'); expect(r.body).toContain('id="code"');
    expect(r.body).not.toMatch(/id="account"|autocomplete="username"|signin-authenticator\.js/);
  });
  it("retains the temporary entry's availability and method fences", () => {
    expect(entry("/signin/authenticator", "POST").status).toBe(405);
    expect(entry("/signin/authenticator", "GET", false).status).toBe(404);
  });
});
