import { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { expect, it, vi } from "vitest";
import { handleContactAuthorizationApi, type ContactApiHost } from "../src/contact-auth-api.js";
import type { ContactPerson } from "../src/contact-auth-types.js";

const actor: ContactPerson = { platform: "discord", adapterId: "fake-bot", userId: "fake-admin", label: "Admin" };
const ticket = "R12345678-1234-4321-abcd-123456789012";
class Response extends ServerResponse {
  code = 0; body = "";
  private finishedCallback!: () => void;
  readonly done = new Promise<void>(resolve => { this.finishedCallback = resolve; });
  override writeHead(code: number): this { this.code = code; return this; }
  override end(value?: unknown): this { this.body = String(value ?? ""); this.finishedCallback(); return this; }
}
function rig() {
  return { contactActor: vi.fn((_req: IncomingMessage, _url: URL): ContactPerson | null => actor),
    contactPermissions: vi.fn(() => ({ revision: 3 })), writeContactPermissions: vi.fn(() => ({ revision: 4 })),
    contactAuthorization: vi.fn(() => ({ id: ticket })), contactAuthorizations: vi.fn(() => ({ items: [], nextCursor: null })),
    decideContactAuthorization: vi.fn(() => ({ id: ticket, state: "approved" })),
  };
}
async function call(host: ReturnType<typeof rig>, method: string, path: string, body: unknown = {}) {
  const request = Readable.from([JSON.stringify(body)]) as unknown as IncomingMessage;
  request.method = method; request.url = path; request.headers = { host: "localhost" };
  const response = new Response(request);
  expect(handleContactAuthorizationApi(request, response, new URL(path, "http://localhost"), host as unknown as ContactApiHost)).toBe(true);
  await response.done;
  return { status: response.code, body: JSON.parse(response.body) };
}
it("refuses absent identity and identity lost while reading the write body", async () => {
  const host = rig(); host.contactActor.mockReturnValue(null);
  expect((await call(host, "GET", "/ui/api/contact-authorizations")).status).toBe(403);
  expect(host.contactAuthorizations).not.toHaveBeenCalled();
  host.contactActor.mockReturnValueOnce(actor).mockReturnValue(null);
  expect((await call(host, "POST", `/ui/api/contact-authorizations/${ticket}/decision`, { revision: 1, decision: "approve-once" })).status).toBe(403);
  expect(host.decideContactAuthorization).not.toHaveBeenCalled();
});
it("does not take an actor, target, content or wildcard tool from a decision form", async () => {
  const host = rig();
  for (const extra of [{ actor }, { target: "other" }, { message: "replacement" }]) {
    expect((await call(host, "POST", `/ui/api/contact-authorizations/${ticket}/decision`, {
      revision: 1, decision: "approve-once", ...extra,
    })).status).toBe(400);
  }
  expect((await call(host, "PUT", "/ui/api/instances/room/contact-permissions", {
    revision: 0, roomTools: { publicRead: true, allowedMcpTools: [{ name: "mcp__*__*", kind: "mcp", usesOwnerAccount: false }] },
  })).status).toBe(400);
  expect(host.decideContactAuthorization).not.toHaveBeenCalled(); expect(host.writeContactPermissions).not.toHaveBeenCalled();
});
it("passes only the exact decision to the server's retained request and preserves conflict errors", async () => {
  const host = rig();
  expect((await call(host, "POST", `/ui/api/contact-authorizations/${ticket}/decision`, { revision: 2, decision: "approve-once" })).status).toBe(200);
  expect(host.decideContactAuthorization).toHaveBeenCalledWith(ticket, { revision: 2, decision: "approve-once" }, actor);
  host.decideContactAuthorization.mockImplementation(() => { throw Error("already-decided"); });
  expect(await call(host, "POST", `/ui/api/contact-authorizations/${ticket}/decision`, { revision: 2, decision: "decline" }))
    .toEqual({ status: 409, body: { error: "already-decided" } });
});
