import { request } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
const home = mkdtempSync(join(tmpdir(), "resend-home-")); process.env.AGEND_HOME = home;
const { FleetManager } = await import("../src/fleet-manager.js");
const { WEB_CSRF_HEADER, WEB_SESSION_COOKIE } = await import("../src/web-auth.js");
const { admittedHumanWebIngress } = await import("../src/human-delivery-receipts.js");
const { csrfTokenFor, tokenEpoch } = await import("../src/web-session.js");
let fm: any, port: number, dir: string, sid: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "resend-fleet-"));
  writeFileSync(join(dir, "fleet.yaml"), `health_port: 0\ninstances:\n  example:\n    working_directory: ${dir}\n    backend: codex\n`);
  fm = new FleetManager(dir); const quiet = () => {};
  fm.logger = { info: quiet, warn: quiet, error: quiet, debug: quiet, trace: quiet, child: () => fm.logger };
  fm.notifyFleetError = () => true; fm.loadConfig(join(dir, "fleet.yaml"));
  fm.lifecycle = { isPaused: () => false, hasWorkLease: () => false, daemons: new Map() };
  fm.getInstanceStatus = () => "running"; fm.initializeWebAuthTokens(); fm.startHealthServer(0);
  await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true));
  port = fm.healthServer.address().port; fm.initializeWebSessions?.();
  fm.instanceIpcClients.set("example", { connected: true, send: () => true });
  sid = fm.webSessions.create({ tier: "admin", surface: "local", label: "admin", tokenEpoch: tokenEpoch(fm.getDashboardAccess().token) }).sessionId;
  fm.startNeedsYou();
}, 30_000);
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await fm.needsYou?.stop(); await fm.webChatStore?.flush();
  await new Promise<void>(resolve => fm.healthServer.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
});
function post(path: string, body: unknown, session = sid, csrf = true): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, method: "POST", path, headers: {
      cookie: `${WEB_SESSION_COOKIE}=${session}`, origin: `http://127.0.0.1:${port}`, "content-type": "application/json",
      ...(csrf ? { [WEB_CSRF_HEADER]: csrfTokenFor(session) } : {}),
    } }, res => { let data = ""; res.on("data", c => data += c); res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(data) })); });
    req.on("error", reject); req.end(JSON.stringify(body));
  });
}
async function accepted(extra = {}) {
  const r = await post("/ui/send", { instance: "example", message: "Please check the release", ...extra }); expect(r.status).toBe(200);
  const row = fm.webChatHistory.list("example").find((m: any) => m.messageId === r.body.messageId);
  fm.finishDeliveryStatus("example", "web", row.messageId, "failed"); return row;
}
const retry = (m: any) => ({ instance: "example", boot: m.boot, id: m.id, attempt: m.retry.attempt });

it("double-tap sends once on the same bubble, preserves quote/files, fences old reports and clears Needs you only when confirmed", async () => {
  const deliver = vi.spyOn(fm, "deliverHumanToInstance").mockResolvedValue(true);
  const quote = fm.webChatHistory.record({ instance: "example", role: "agent", sender: "Example Agent", text: "Release checklist", ts: new Date().toISOString() });
  const inbox = join(dir, "inbox"); mkdirSync(inbox, { recursive: true });
  const file = fm.webFiles.storeUpload({ instance: "example", inboxDir: inbox, bytes: Buffer.from("Synthetic checklist"), name: "checklist.txt", type: { kind: "document", mime: "text/plain", ext: ".txt" } });
  const row = await accepted({ attachments: [file.id], replyTo: { boot: quote.boot, id: quote.id } });
  const originalId = row.messageId, payload = retry(row), count = fm.webChatHistory.list("example").length;
  expect(row.retry?.owner).toBeTruthy();
  await vi.waitFor(() => expect(fm.needsYouItems().some((i: any) => i.deliveryId === `web:${row.boot}:${row.id}`)).toBe(true));
  deliver.mockClear(); let release!: () => void;
  deliver.mockImplementation(async () => { await new Promise<void>(resolve => release = resolve); return true; });
  const first = post("/ui/resend", payload);
  await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
  const second = await post("/ui/resend", payload); expect(second.status).toBe(200); expect(second.body.repeated).toBe(true);
  expect(deliver).toHaveBeenCalledOnce(); expect(fm.webChatHistory.list("example")).toHaveLength(count);
  const sent = deliver.mock.calls[0][1] as any;
  expect(sent.meta.reply_to_text).toContain("Release checklist"); expect(sent.meta.attachment_path).toBe(file.path);
  expect(row.attachments[0].id).toBe(file.id); expect(row.messageId).not.toBe(originalId);
  expect(fm.webChatHistory.failedWebDeliveries(0)).toContainEqual(expect.objectContaining({ deliveryId: `web:${row.boot}:${row.id}` }));
  fm.finishDeliveryStatus("example", "web", originalId, "delivered");
  expect(fm.webChatHistory.failedWebDeliveries(0).some((d: any) => d.deliveryId === `web:${row.boot}:${row.id}`)).toBe(true);
  release(); expect((await first).status).toBe(200);
  fm.finishDeliveryStatus("example", "web", row.messageId, "processing");
  expect(fm.webChatHistory.failedWebDeliveries(0).some((d: any) => d.deliveryId === `web:${row.boot}:${row.id}`)).toBe(true);
  fm.finishDeliveryStatus("example", "web", row.messageId, "delivered");
  await vi.waitFor(() => expect(fm.needsYouItems().some((i: any) => i.deliveryId === `web:${row.boot}:${row.id}`)).toBe(false));
  expect(fm.webChatHistory.list("example")).toHaveLength(count);
});

it("refuses another owner, forged content, missing CSRF and a replaced attachment without a resend", async () => {
  const deliver = vi.spyOn(fm, "deliverHumanToInstance").mockResolvedValue(true);
  const inbox = join(dir, "inbox");
  const file = fm.webFiles.storeUpload({ instance: "example", inboxDir: inbox, bytes: Buffer.from("Synthetic file"), name: "note.txt", type: { kind: "document", mime: "text/plain", ext: ".txt" } });
  const row = await accepted({ attachments: [file.id] }); deliver.mockClear();
  expect((await post("/ui/resend", { ...retry(row), message: "forged" })).status).toBe(400);
  expect((await post("/ui/resend", retry(row), sid, false)).status).toBe(403);
  const owner = row.retry.owner; row.retry.owner = "example:other";
  expect((await post("/ui/resend", retry(row))).status).toBe(404); row.retry.owner = owner;
  renameSync(file.path, file.path + ".old"); writeFileSync(file.path, "Replacement");
  const missing = await post("/ui/resend", retry(row)); expect(missing.status).toBe(409); expect(missing.body.reason).toBe("attachment_gone");
  expect(deliver).not.toHaveBeenCalled(); expect(row.delivery).toBe("failed"); expect(row.attachments[0].id).toBe(file.id);
});

it("keeps the original quote and bubble when its quoted row is gone", async () => {
  const deliver = vi.spyOn(fm, "deliverHumanToInstance").mockResolvedValue(true);
  const quote = fm.webChatHistory.record({ instance: "example", role: "agent", sender: "Example Agent", text: "An earlier answer", ts: new Date().toISOString() });
  const row = await accepted({ replyTo: { boot: quote.boot, id: quote.id } }); deliver.mockClear();
  const slot = fm.webChatHistory.byInstance.get("example"); slot.messages = slot.messages.filter((m: any) => m !== quote);
  const r = await post("/ui/resend", retry(row));
  expect(r.status).toBe(409); expect(r.body.reason).toBe("reply_gone"); expect(deliver).not.toHaveBeenCalled();
  expect(row.replyTo.id).toBe(quote.id); expect(row.delivery).toBe("failed");
});

it("passes current admission through the handoff and keeps one failed row if that admission is revoked", async () => {
  const deliver = vi.spyOn(fm, "deliverHumanToInstance").mockResolvedValue(true);
  const row = await accepted(), count = fm.webChatHistory.list("example").length;
  const otherSid = fm.webSessions.create({ tier: "admin", surface: "local", label: "new session", tokenEpoch: tokenEpoch(fm.getDashboardAccess().token) }).sessionId;
  deliver.mockImplementation(async (...args: any[]) => {
    expect(args[4].stillCurrent()).toBe(true); fm.webSessions.revokeById(otherSid);
    expect(args[4].stillCurrent()).toBe(false); return false;
  });
  const r = await post("/ui/resend", retry(row), otherSid);
  expect(r.status).toBe(503); expect(row.delivery).toBe("failed"); expect(fm.webChatHistory.list("example")).toHaveLength(count);
});

it("a lost HTTP answer after handoff neither fails the accepted attempt nor resends it twice", async () => {
  const deliver = vi.spyOn(fm, "deliverHumanToInstance").mockResolvedValue(true);
  const row = await accepted(), payload = retry(row); deliver.mockClear();
  fm.healthServer.prependOnceListener("request", (_req: unknown, res: any) => {
    res.end = () => { res.destroy(); throw new Error("owned response-loss fixture"); };
  });
  await expect(post("/ui/resend", payload)).rejects.toThrow();
  await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
  expect(row.delivery).toBe("queued");
  const replay = await post("/ui/resend", payload);
  expect(replay.status).toBe(200); expect(replay.body.repeated).toBe(true); expect(deliver).toHaveBeenCalledOnce();
});

it("resends the full accepted 16384-character payload including its suffix after restoration", async () => {
  const deliver = vi.spyOn(fm, "deliverHumanToInstance").mockResolvedValue(true);
  const suffix = "BOUNDARY-SUFFIX-12345", text = "x".repeat(16384 - suffix.length) + suffix;
  expect(text).toHaveLength(16384);
  const row = await accepted({ message: text });
  expect(row.text).toHaveLength(16384); expect(row.text.endsWith(suffix)).toBe(true);
  // Use the same persisted snapshot and restore API as a host restart.
  const saved = [fm.webChatHistory.stored(row)];
  const { WebChatHistory } = await import("../src/web-chat-history.js");
  const restored = new WebChatHistory({ boot: "dcba" }); restored.restore("example", saved);
  expect(restored.find("example", row.boot, row.id)?.text).toBe(text);
  const previous = fm.webChatHistory; fm.webChatHistory = restored;
  try {
    deliver.mockClear(); expect((await post("/ui/resend", retry(row))).status).toBe(200);
    expect(JSON.stringify(deliver.mock.calls[0]).includes(text)).toBe(true);
  } finally { fm.webChatHistory = previous; }
});

it("a resend captures the new admitted browser, not the original message's route or a body claim",async()=>{
 const deliver=vi.spyOn(fm,"deliverHumanToInstance").mockResolvedValue(true),row=await accepted();
 const old=admittedHumanWebIngress(deliver.mock.calls.at(-1)![2] as any)!;
 const next=fm.webSessions.create({tier:"admin",surface:"local",label:"second browser",tokenEpoch:tokenEpoch(fm.getDashboardAccess().token)});
 deliver.mockClear();expect((await post("/ui/resend",retry(row),next.sessionId)).status).toBe(200);
 const route=admittedHumanWebIngress(deliver.mock.calls[0]![2] as any)!;
 expect(route.sessionHandle).toBe(next.record.handle);expect(route.sessionHandle).not.toBe(old.sessionHandle);
 expect(deliver.mock.calls[0]![2]).not.toHaveProperty("web_identity");
});
