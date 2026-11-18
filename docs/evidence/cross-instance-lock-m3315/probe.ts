/** Manual, inert dispatch probe. Run with node --import tsx; never starts a Fleet. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { FleetManager } from "../../../src/fleet-manager.js";
import { DeliveryOutbox } from "../../../src/delivery-outbox.js";
import { HubContactWindows, HUB_CONTACT_WINDOW_MS } from "../../../src/hub-contact-windows.js";
import { dispatchAgentOperation } from "../../../src/agent-endpoint.js";
import { setLocale } from "../../../src/locale.js";

const root = mkdtempSync(join(tmpdir(), "agend-m3315-owned-"));
const outbox = new DeliveryOutbox(join(root, "outbox.db"), "probe");
let now = 1000;
const windows = new HubContactWindows(join(root, "windows.json"), () => now);
const names = ["worker-a", "worker-b", "coordinator", "general", "classic-room", "shared-agent"];
const profiles: Record<string, string> = { coordinator: "coordinator", general: "general" };
const daemons = new Map(names.map(name => [name, { bootId: `${name}-boot` }]));
const responses: any[] = [];
const noop = () => {};
const logger = { info: noop, warn: noop, error: noop, debug: noop };
// No FleetManager constructor, network adapters, running daemon, tmux or pump.
const ctx: any = {
  fleetConfig: { defaults: {}, instances: Object.fromEntries(names.filter(n => n !== "classic-room").map(n => [n, { tool_set: profiles[n] ?? "worker", ...(n === "general" ? { general_topic: true } : {}) }])),
    teams: { alpha: { members: ["worker-a", "coordinator"] }, beta: { members: ["worker-b"] } } },
  daemons, deliveryOutbox: outbox, logger, adapter: null, classicChannels: null,
  instanceIpcClients: new Map(names.map(n => [n, { connected: true, send: (msg: unknown) => { responses.push(msg); return true; } }])),
  sessionRegistry: new Map([["external-session", "worker-b"]]),
  lifecycle: { daemons, isPaused: () => false }, eventLog: null,
  touchActivity: noop, setTopicIcon: noop, publishTraffic: noop, scheduleDeliveryOutboxPump: noop,
  generalBindings: () => ({ read: () => null }),
  emitSseEvent: noop, sendCancelButton: noop, notifyInstanceTopic: noop,
  hubContactRestricted: (name: string) => windows.restricted(name),
  hubReport: (input: any) => input.caller === "shared-agent" && input.correlationId === "hub-owned-question"
    ? Promise.resolve({ ok: true }) : null,
  lastActivityMs: () => 0,
};
for (const method of ["getDaemonBootId", "generalLocationDeliveryHold", "admitDurableDelivery", "checkToolPermission"])
  ctx[method] = (FleetManager.prototype as any)[method].bind(ctx);
const kinds = {
  send_to_instance: (to: string) => ({ instance_name: to, message: "Synthetic probe" }),
  delegate_task: (to: string) => ({ target_instance: to, task: "Synthetic task" }),
  request_information: (to: string) => ({ target_instance: to, question: "Synthetic question" }),
  report_result: (to: string) => ({ target_instance: to, summary: "Synthetic report", correlation_id: "never-issued" }),
  broadcast: (to: string) => ({ targets: [to], message: "Synthetic broadcast" }),
};
async function ipc(sender: string, tool: string, args: any, extra = {}) {
  const before = responses.length;
  await (FleetManager.prototype as any).handleOutboundFromInstance.call(ctx, sender,
    { tool, args, fleetRequestId: randomUUID(), operationId: randomUUID(), sourceDaemonBootId: `${sender}-boot`, ...extra });
  assert.equal(responses.length, before + 1);
  return responses.at(-1);
}
const ledger: Record<string, unknown> = { date: "2026-11-18", scope: "Real IPC dispatch + SQLite admission, inert pump; no terminal or live Fleet" };
try {
  setLocale("en");
  let admitted = 0;
  for (const from of names) for (const to of names.filter(n => n !== from)) for (const [tool, args] of Object.entries(kinds)) {
    const reply = await ipc(from, tool, args(to));
    assert.equal(reply.error, undefined, `${from} -> ${to} ${tool}: ${reply.error}`);
    assert.equal(reply.result.queued, true);
    admitted++;
  }
  ledger.directedPairs = names.length * (names.length - 1);
  ledger.fiveToolAdmissions = admitted;
  const teams = await ipc("worker-b", "list_teams", {});
  assert.equal(teams.error, undefined);
  assert.deepEqual(teams.result.map((team: any) => team.name), ["alpha", "beta"]);
  ledger.listTeams = "outside-team worker can inspect both Fleet teams";
  const team = await ipc("worker-b", "broadcast", { team: "alpha", message: "Synthetic team message" });
  assert.equal(team.result.sent, 2); assert.equal(team.error, undefined);
  ledger.outsideTeamBroadcast = "worker-b (beta) -> both alpha members accepted";
  const session = await ipc("worker-a", "send_to_instance", { instance_name: "external-session", message: "Synthetic session message" });
  assert.equal(session.error, undefined); assert.equal(session.result.queued, true);
  ledger.externalSession = "resolved to worker-b host; accepted";
  windows.begin("shared-agent", "hub-owned-question");
  for (const [tool, args] of Object.entries(kinds)) {
    const reply = await ipc("shared-agent", tool, args("general"));
    assert.match(reply.error, /while it answers a Hub question/);
  }
  const hub = await ipc("shared-agent", "report_result", { target_instance: "agend-hub", correlation_id: "hub-owned-question", summary: "Synthetic answer" });
  assert.equal(hub.error, undefined); assert.equal(hub.result.sent, true);
  const forged = await ipc("shared-agent", "report_result", { target_instance: "agend-hub", correlation_id: "forged", summary: "Synthetic answer" });
  assert.match(forged.error, /while it answers a Hub question/);
  ledger.hubWindow = "all 5 peer tools refused; bound answer accepted; forged answer refused";
  const incoming = await ipc("worker-a", "send_to_instance", kinds.send_to_instance("shared-agent"));
  assert.equal(incoming.error, undefined);
  ledger.hubWindowIncoming = "peer can still send to restricted shared-agent";
  now += HUB_CONTACT_WINDOW_MS;
  assert.equal((await ipc("shared-agent", "send_to_instance", kinds.send_to_instance("general"))).error, undefined);
  ledger.hubExpiry = "peer contact resumes at 30 minutes";
  ctx.fleetConfig.instances["worker-a"].tool_set = "minimal";
  assert.equal((await ipc("worker-a", "send_to_instance", kinds.send_to_instance("general"))).error, undefined);
  for (const tool of ["delegate_task", "request_information", "report_result", "broadcast"] as const)
    assert.match((await ipc("worker-a", tool, kinds[tool]("general"))).error, /not available/);
  ledger.minimal = "send accepted; delegate/request/report/broadcast refused by tool profile";
  ctx.fleetConfig.instances["worker-a"].tool_set = "worker";
  let http = 0;
  for (const [op, tool] of Object.entries({ send: "send_to_instance", delegate: "delegate_task", ask: "request_information", report: "report_result", broadcast: "broadcast" })) {
    const reply: any = await dispatchAgentOperation(ctx, "worker-a", op, (kinds as any)[tool]("general"));
    assert.equal(reply.error, undefined); assert.equal(reply.queued, true); http++;
  }
  ledger.agentEndpointDispatchAdmissions = http;
  const oversized = await ipc("worker-a", "send_to_instance", { instance_name: "general", message: "x".repeat(12_289) });
  assert.match(oversized.error, /too long/);
  ledger.oversized = "12,289-byte body refused";
  console.log(JSON.stringify(ledger, null, 2));
} finally { outbox.close(); rmSync(root, { recursive: true, force: true }); }
