import { expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleAgentRequest } from "../src/agent-endpoint.js";
import { AgentCredentials, agentCredentialPolicy } from "../src/agent-credentials.js";
import { agentTokenHeader } from "../src/agent-token-header.js";

it("compact HTTP body hides operation_id but response completion still acknowledges the same durable operation", async () => {
  const root = mkdtempSync(join(tmpdir(), "compact-ack-http-"));
  const token = "t".repeat(64);
  mkdirSync(join(root, "instances", "sender"), { recursive: true });
  writeFileSync(join(root, "instances", "sender", "agent.token"), token, { mode: 0o600 });
  const fleetConfig = { defaults: {}, instances: { sender: { tool_set: "worker" }, target: {} } };
  const credentials = new AgentCredentials(name => agentCredentialPolicy(fleetConfig as any, name), () => null);
  credentials.issue("sender", token);
  const admission = vi.fn(() => ({ deliveryId: "delivery-http", state: "queued", duplicate: false }));
  const marked = vi.fn();
  const ctx: any = { dataDir: root, fleetConfig, agentCredentials: credentials, instanceIpcClients: new Map([["target", { connected: true }]]), sessionRegistry: new Map(), lifecycle: { daemons: new Map(), isPaused: () => false }, logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }, getInstanceStatus: () => "running", getDaemonBootId: () => "source-boot", admitDurableDelivery: admission, markDurableResponseDelivered: marked, eventLog: { logActivity: vi.fn() } };
  const server = createServer((req, res) => handleAgentRequest(req, res, ctx));
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const res = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/agent`, { method: "POST", headers: { "Content-Type": "application/json", "X-Agend-Instance-Token": agentTokenHeader("sender", token) }, body: JSON.stringify({ instance: "sender", op: "send", args: { instance_name: "target", message: "synthetic" } }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: true, queued: true, delivery_id: "delivery-http" });
    expect(admission).toHaveBeenCalledOnce();
    expect(marked).toHaveBeenCalledExactlyOnceWith("sender", (admission.mock.calls[0] as any)[0].operationId);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
