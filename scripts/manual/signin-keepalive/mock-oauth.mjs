// #3292 offline rig: a mock OAuth token endpoint (and, for Claude, the profile endpoint) that records every request.
// Modes (MOCK_MODE): ok | expired | invalid_grant | server_error | down (closes the socket).
// Plain HTTP for Codex (CODEX_REFRESH_TOKEN_URL_OVERRIDE); HTTPS via mitm-proxy.mjs for Claude. Fake tokens only.
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";

const b64 = o => Buffer.from(JSON.stringify(o)).toString("base64url");
export const fakeJwt = claims => `${b64({ alg: "none", typ: "JWT" })}.${b64(claims)}.${"s".repeat(16)}`;
export const codexIdClaims = (plan, expS) => ({ email: "rig@example.invalid", exp: expS, iat: expS - 3600,
  "https://api.openai.com/auth": { chatgpt_plan_type: plan, chatgpt_account_id: "acc-rig", chatgpt_user_id: "user-rig" } });

export function startMock({ port = 0, mode = () => process.env.MOCK_MODE ?? "ok", log, plan = "plus" } = {}) {
  let n = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => {
      const m = mode(req.url ?? "");
      let grant = null, rt = null;
      try { const j = JSON.parse(body); grant = j.grant_type ?? null; rt = typeof j.refresh_token === "string" ? `${j.refresh_token.slice(0, 4)}…(${j.refresh_token.length})` : null; } catch {
        try { const p = new URLSearchParams(body); grant = p.get("grant_type"); } catch { /* none */ }
      }
      const entry = { at: new Date().toISOString(), method: req.method, path: req.url, host: req.headers.host, grant, refreshToken: rt, mode: m };
      if (log) appendFileSync(log, JSON.stringify(entry) + "\n");
      if (m === "down") { req.socket.destroy(); return; }
      const send = (status, obj) => { res.writeHead(status, { "content-type": "application/json", "request-id": `req_rig${++n}` }); res.end(JSON.stringify(obj)); };
      if (req.url?.startsWith("/api/oauth/profile")) return send(200, { account: { uuid: "acc-rig", email: "rig@example.invalid", display_name: "Rig" }, organization: { uuid: "org-rig", name: "Rig org", organization_type: "claude_team", rate_limit_tier: "default_claude_max_5x" } });
      if (req.url?.startsWith("/v1/messages")) return send(200, { id: "msg_rig", type: "message", role: "assistant", model: "claude-haiku-rig", content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } });
      if (!/\/oauth\/token$/.test(req.url ?? "")) return send(404, { error: "not_found" });
      if (m === "server_error") return send(503, { error: "temporarily_unavailable" });
      if (m === "expired") return send(401, { error: { code: "refresh_token_expired", message: "expired" } });
      if (m === "invalid_grant") return send(400, { error: "invalid_grant", error_description: "Refresh token not found or invalid" });
      const now = Math.floor(Date.now() / 1000);
      if (req.url.startsWith("/v1/oauth/token")) {
        // Claude Code shape.
        return send(200, { access_token: `rig-at-${n}-${"a".repeat(24)}`, refresh_token: `rig-rt-${n}-${"r".repeat(24)}`, expires_in: 28800, token_type: "Bearer",
          scope: "user:inference user:profile user:sessions:claude_code", ...(process.env.MOCK_RT_EXPIRES_IN ? { refresh_token_expires_in: Number(process.env.MOCK_RT_EXPIRES_IN) } : {}),
          account: { uuid: "acc-rig", email_address: "rig@example.invalid" }, organization: { uuid: "org-rig" } });
      }
      return send(200, { id_token: fakeJwt(codexIdClaims(plan, now + 3600)), access_token: fakeJwt({ exp: now + 10 * 86400, "https://api.openai.com/auth": { chatgpt_plan_type: plan } }), refresh_token: `rig-rt-${n}-${"r".repeat(24)}` });
    });
  });
  return new Promise(resolve => server.listen(port, "127.0.0.1", () => resolve({ server, port: server.address().port })));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { port } = await startMock({ port: Number(process.env.MOCK_PORT ?? 0), log: process.env.MOCK_LOG });
  console.log(`mock-oauth listening on ${port}`);
}
