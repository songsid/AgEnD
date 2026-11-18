import { expect, it, vi } from "vitest";
// @ts-expect-error browser module
import { createHubWebClient } from "../src/ui/hub-client.js";

const response = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status,
  headers: { get: () => null }, json: async () => body });
async function fixture() {
  let csrf = "scope-one", answer: (path: string, init: any) => Promise<any> = async () => response(200, { requests: [], next: null });
  const fetch = vi.fn(async (path: string, init: any = {}) => {
    if (path === "/hub/v1/session") {
      if (init.method === "POST") csrf = "scope-two";
      return response(200, { signedIn: true, csrf, features: ["rooms-v1"] });
    }
    return answer(path, init);
  });
  const client = createHubWebClient({ fetchImpl: fetch });
  await client.session(); fetch.mockClear();
  return { client, fetch, setAnswer: (value: typeof answer) => { answer = value; } };
}

it("sends scoped request/cancel/settings bodies through the ordinary CSRF client", async () => {
  const f = await fixture(), scope = f.client.roomAgentRequestScope();
  const body = { owner: "corp/00000000-0000-4000-8000-000000000042", note: "Example hint", idempotencyKey: "00000000-0000-4000-8000-000000000043" };
  await f.client.requestRoomAgent(scope, "room/one", body);
  await f.client.roomAgentRequests(scope, "room/one", "cursor/one");
  await f.client.cancelRoomAgentRequest(scope, "room/one", "request/one");
  await f.client.agentRequestSettings(scope, { accepting: false });
  expect(f.fetch.mock.calls.map(([path, init]) => [path, init.method, init.headers["X-AgEnD-Hub-CSRF"], init.body && JSON.parse(init.body)])).toEqual([
    ["/hub/v1/rooms/room%2Fone/agent-requests", "POST", scope, body],
    ["/hub/v1/rooms/room%2Fone/agent-requests?after=cursor%2Fone", "GET", undefined, undefined],
    ["/hub/v1/rooms/room%2Fone/agent-requests/request%2Fone", "DELETE", scope, undefined],
    ["/hub/v1/me/agent-request-settings", "PUT", scope, { accepting: false }],
  ]);
});

it("does not send through a retired scope", async () => {
  const f = await fixture(), scope = f.client.roomAgentRequestScope();
  await f.client.signIn("fixture-user", "fixture-password");
  f.fetch.mockClear();
  expect(await f.client.requestRoomAgent(scope, "room", {})).toMatchObject({ ok: false, status: 401 });
  expect(f.fetch).not.toHaveBeenCalled();
});

it("does not disclose a late old-session response after a different sign-in", async () => {
  const f = await fixture(), scope = f.client.roomAgentRequestScope();
  let release!: (value: unknown) => void;
  f.setAnswer(() => new Promise(resolve => { release = resolve; }));
  const pending = f.client.requestRoomAgent(scope, "room", {});
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  await f.client.signIn("fixture-user", "fixture-password");
  release(response(200, { request: { id: "OLD_PRIVATE_REQUEST" } }));
  const result = await pending;
  expect(result).toMatchObject({ ok: false, status: 401 });
  expect(JSON.stringify(result)).not.toContain("OLD_PRIVATE_REQUEST");
});

it.each([null, "tomorrow", -1, 1.5, Number.MAX_SAFE_INTEGER])("discards malformed reset timestamps (%j)", async resetsAt => {
  const f = await fixture();
  f.setAnswer(async () => response(429, { code: "request-limit", resetsAt, private: "must stay private" }));
  const result = await f.client.requestRoomAgent(f.client.roomAgentRequestScope(), "room", {});
  expect(result.resetsAt).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain("must stay private");
});

it("retains a valid quota reset time for local UI formatting", async () => {
  const f = await fixture(), resetsAt = Date.UTC(2026, 10, 20);
  f.setAnswer(async () => response(429, { code: "request-limit", resetsAt }));
  expect(await f.client.requestRoomAgent(f.client.roomAgentRequestScope(), "room", {})).toMatchObject({ ok: false, code: "request-limit", resetsAt });
});
