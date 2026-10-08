import { request } from "node:http";
import { expect } from "vitest";
import { requestSettingsConfirmation, type SettingsInspection } from "../../src/settings-control.js";

/** HTTP + same-user private Unix socket only; no fleet/platform/process. */
export async function setupHttp(port: number, path: string, method = "GET", body?: unknown, cookie?: string) {
  return new Promise<{ status: number; body: any; headers: any }>((resolve, reject) => {
    const text = body === undefined ? "" : JSON.stringify(body);
    const req = request({ host: "127.0.0.1", port, path, method, headers: {
      ...(text ? { "content-type": "application/json", "content-length": Buffer.byteLength(text) } : {}), ...(cookie ? { cookie } : {}),
    } }, res => {
      let data = ""; res.on("data", chunk => { data += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, body: data ? JSON.parse(data) : null, headers: res.headers }));
    }); req.on("error", reject); req.end(text);
  });
}
export async function inspectSetup(dir: string, id: string): Promise<SettingsInspection> {
  // The host CLI is not an agent. Explicitly emulate that environment, then restore it.
  const agent = process.env.AGEND_INSTANCE_NAME; delete process.env.AGEND_INSTANCE_NAME;
  try { return await requestSettingsConfirmation(dir, { action: "inspect", id }) as SettingsInspection; }
  finally { if (agent !== undefined) process.env.AGEND_INSTANCE_NAME = agent; }
}
export async function decideSetup(dir: string, id: string, action: "confirm" | "reject" = "confirm") {
  const inspection = await inspectSetup(dir, id);
  const agent = process.env.AGEND_INSTANCE_NAME; delete process.env.AGEND_INSTANCE_NAME;
  try { return await requestSettingsConfirmation(dir, { action, ticket: inspection.ticket }); }
  finally { if (agent !== undefined) process.env.AGEND_INSTANCE_NAME = agent; }
}
export const setupPayload = { platform: "telegram", token_env: "AGEND_BOT_TOKEN", backend: "claude-code",
  working_directory: "/tmp/app", instance_name: "agent-1", group_id: "-100123", admin_user_id: "42", token: "123456:ABC" };
export async function confirmedSetup(dir: string, port: number, path: string, cookie: string) {
  const proposed = await setupHttp(port, path + "api/settings/quickstart/commit", "POST", setupPayload, cookie);
  expect(proposed.status).toBe(202);
  const result = await decideSetup(dir, proposed.body.pending_change.id);
  expect(result.pending_change.state).toBe("applied");
  return result;
}
export async function admitSetupFinish(dir: string, port: number, path: string, code: string) {
  const signed = await setupHttp(port, path + "open", "POST", { code });
  expect(signed.status).toBe(200);
  const cookie = String(signed.headers["set-cookie"]).split(";")[0]!;
  await confirmedSetup(dir, port, path, cookie);
  const finish = await setupHttp(port, path + "setup/finish", "POST", undefined, cookie);
  expect(finish.status).toBe(202);
  return cookie;
}
