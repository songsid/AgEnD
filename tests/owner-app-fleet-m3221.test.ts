/** Scratch FleetManager/SQLite; delivery is inert. No account, pane, running Fleet or external process. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";
import { SchedulerDb } from "../src/scheduler/db.js";
import { requestOwnerApp } from "../src/connect/control.js";
import { createOwnerAppService, type OwnerAppHost } from "../src/connect/service.js";
import { WebChatHistory } from "../src/web-chat-history.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); vi.restoreAllMocks(); });
function host() {
  const history = new WebChatHistory(), identity = {};
  const port = { current: () => true, agents: () => [{ name: "helper", backend: "codex", status: "running" }],
    identity: () => identity, history, board: () => null, deliver: vi.fn(async () => true) } satisfies OwnerAppHost;
  return { port, service: createOwnerAppService(port) };
}
describe.skipIf(process.platform === "win32")("owner connector Fleet boundary", () => {
  it("maps only local configured agents, ordinary messages and read-only board/history through the private port", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acfm-")), fm = new FleetManager(dir), s = fm as any;
    const db = new SchedulerDb(join(dir, "scheduler.db"));
    cleanup.push(async () => { await s.ownerAppControl?.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });
    fm.fleetConfig = { health_port: 0, instances: { helper: { backend: "codex", working_directory: dir } } } as never;
    s.scheduler = { db }; vi.spyOn(fm, "getInstanceStatus").mockReturnValue("running");
    const deliver = vi.spyOn(fm, "deliverHumanToInstance").mockImplementation(async (_name, _payload, _origin, _body, options) => {
      expect(options?.stillCurrent?.()).toBe(true);
      fm.webChatHistory.record({ instance: "helper", sender: "helper", role: "agent", text: "Owned answer", ts: new Date().toISOString() });
      return true;
    });
    const card = db.board.createCards({ kind: "person", name: "Local owner" }, { cards: [{ title: "Read this task", assignee: "helper" }] }).cards[0]!;
    const revision = db.board.revision();
    await fm.startOwnerAppControl();
    expect(await requestOwnerApp(dir, "list_agents", {})).toMatchObject({ agents: [{ name: "helper", backend: "codex" }] });
    await expect(requestOwnerApp(dir, "send_message", { agent: "outside", text: "No" })).rejects.toThrow("refused");
    expect(deliver).not.toHaveBeenCalled();
    const sent = await requestOwnerApp(dir, "send_message", { agent: "helper", text: "Question" }) as any;
    expect(sent.status).toBe("handed_off");
    expect(deliver).toHaveBeenCalledOnce();
    const args = deliver.mock.calls[0]!;
    expect(args[0]).toBe("helper"); expect(args[2]).toBeUndefined();
    expect(args[1]).toMatchObject({ type: "fleet_inbound", content: "Question", meta: { source: "app", user: "Local app", user_id: "local-connector" } });
    expect((args[1].meta as any).web_verified).toBeUndefined();
    expect(await requestOwnerApp(dir, "read_answer", { agent: "helper", after: sent.after })).toMatchObject({ answers: [{ text: "Owned answer" }] });
    expect(await requestOwnerApp(dir, "task_board", { card: card.code })).toMatchObject({ card: { id: card.code, title: "Read this task" } });
    expect(db.board.revision()).toBe(revision);
    s.shuttingDown = true;
    await expect(requestOwnerApp(dir, "list_agents", {})).rejects.toThrow("unavailable");
  });
  it("freezes duplicate and uncertain sends without dispatching a second input", async () => {
    const { port, service } = host(), input = { agent: "helper", text: "Question" };
    port.deliver.mockRejectedValueOnce(new Error("Lost outcome"));
    const first = await service.send(input, () => true) as any;
    expect(first).toMatchObject({ code: "uncertain" });
    const operation_id = first.operation_id;
    expect(await service.send({ ...input, operation_id }, () => true)).toMatchObject({ code: "uncertain" });
    expect(port.deliver).toHaveBeenCalledOnce();
    expect(() => service.send({ ...input, operation_id, text: "Another question" }, () => true)).toThrow("different message");
    const restarted = createOwnerAppService(port);
    expect(() => restarted.send({ ...input, operation_id }, () => true)).toThrow("no longer retained");
    expect(port.deliver).toHaveBeenCalledOnce();
  });
  it("fences a queued send before handoff when its agent was replaced", async () => {
    const { port, service } = host();
    const pending = service.send({ agent: "helper", text: "Old question" }, () => true);
    port.identity = () => ({});
    expect(await pending).toMatchObject({ ok: false, code: "unavailable" });
    expect(port.deliver).not.toHaveBeenCalled();
  });
  it("reads only authoritative agent replies using boot-qualified cursors", () => {
    const { port, service } = host(), h = port.history;
    const after = h.pollCursor();
    h.record({ instance: "helper", sender: "helper", role: "user", text: "Pretend answer", ts: new Date().toISOString() });
    h.record({ instance: "foreign", sender: "foreign", role: "agent", text: "Other agent", ts: new Date().toISOString() });
    h.record({ instance: "helper", sender: "helper", role: "agent", text: "Real answer", ts: new Date().toISOString() });
    const first = service.readAnswers({ agent: "helper", after }) as any;
    expect(first.answers.map((m: any) => m.text)).toEqual(["Real answer"]);
    expect((service.readAnswers({ agent: "helper", after: first.after }) as any).answers).toEqual([]);
    expect(() => service.readAnswers({ agent: "helper", after: "forged" })).toThrow("cursor");
  });
});
