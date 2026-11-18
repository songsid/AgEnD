/**
 * M-3339 (Sentinel's pin for A2, on A1 #4194): a target with a configured, non-empty approvers list — another real Fleet
 * admin of that target outside the list still manages it (canManage) but may not decide its requests: canDecide false, and
 * the decision route answers 403. The real ContactAuthStore + ContactAuthService behind the real API handler (no mock of
 * the decision), so removing the configured-approver membership check turns this red.
 */
import { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { afterEach, expect, it } from "vitest";
import Database from "better-sqlite3";
import { ContactAuthService } from "../src/contact-auth-service.js";
import { ContactAuthStore } from "../src/contact-auth-store.js";
import { handleContactAuthorizationApi, type ContactApiHost } from "../src/contact-auth-api.js";
import type { ContactOrigin, ContactPerson } from "../src/contact-auth-types.js";

const chosen: ContactPerson = { platform: "discord", adapterId: "fake-bot", userId: "fake-admin-chosen", label: "Chosen admin" };
const other: ContactPerson = { platform: "discord", adapterId: "fake-bot", userId: "fake-admin-other", label: "Other admin" };
const member: ContactPerson = { platform: "discord", adapterId: "fake-bot", userId: "fake-member", label: "Member" };
const origin: ContactOrigin = { kind: "human", people: [member], receiptIds: ["fake-receipt"], chain: ["room"] };
const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

class Response extends ServerResponse {
  code = 0; body = "";
  private finishedCallback!: () => void;
  readonly done = new Promise<void>(resolve => { this.finishedCallback = resolve; });
  override writeHead(code: number): this { this.code = code; return this; }
  override end(value?: unknown): this { this.body = String(value ?? ""); this.finishedCallback(); return this; }
}

function world() {
  const db = new Database(":memory:"); databases.push(db);
  const store = new ContactAuthStore(db, () => 1_000);
  const generations: Record<string, string> = { room: "source-one", worker: "target-one" };
  let admitted = 0;
  // Both are the worker's Fleet admins (its channel's admins: the default approvers); the policy then names only one.
  const service = new ContactAuthService({ store, generation: name => generations[name]!, restricted: () => true,
    defaultApprovers: () => [chosen, other], adminOf: () => false, hubRestricted: () => false,
    delivered: () => false, admit: () => { admitted++; return "fake-delivery"; }, changed: () => {} });
  store.writePolicy("worker", { revision: 0, approvers: [chosen] }, chosen, name => generations[name]!);
  const ticket = store.hold({ operationId: "fake-operation", source: "room", target: "worker", sourceGeneration: generations.room!,
    targetGeneration: generations.worker!, verb: "delegate_task", origin, message: "Read public information",
    correlationId: "fake-correlation", resultRecipient: "room", payload: { content: "Read public information" } });
  let actor: ContactPerson = other;
  const host = {
    contactActor: () => actor,
    contactAuthorization: (id: string) => service.view(store.get(id)!, actor),
    decideContactAuthorization: (id: string, decision: any, who: ContactPerson) => service.decide(id, decision, who),
  } as unknown as ContactApiHost;
  const decide = async (who: ContactPerson) => {
    actor = who;
    const path = `/ui/api/contact-authorizations/${ticket.id}/decision`;
    const request = Readable.from([JSON.stringify({ revision: ticket.revision, decision: "approve-once" })]) as unknown as IncomingMessage;
    request.method = "POST"; request.url = path; request.headers = { host: "localhost" };
    const response = new Response(request);
    expect(handleContactAuthorizationApi(request, response, new URL(path, "http://localhost"), host)).toBe(true);
    await response.done;
    return { status: response.code, body: JSON.parse(response.body) };
  };
  return { store, service, ticket, decide, admitted: () => admitted };
}

it("a configured approver list: another Fleet admin of the target manages it but gets 403 on the decision; the chosen approver decides", async () => {
  const w = world();
  expect(w.service.canManage("worker", other), "still the target's admin").toBe(true);
  expect(w.service.view(w.ticket, other).canDecide).toBe(false);
  expect(w.service.view(w.ticket, chosen).canDecide).toBe(true);
  expect((await w.decide(other)).status).toBe(403);
  expect([w.admitted(), w.store.get(w.ticket.id)!.state], "nothing admitted, still pending").toEqual([0, "pending"]);
  const ok = await w.decide(chosen);
  expect([ok.status, ok.body.state, w.admitted()]).toEqual([200, "approved", 1]);
});
