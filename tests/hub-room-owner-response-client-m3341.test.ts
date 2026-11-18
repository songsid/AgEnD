import { expect, it, vi } from "vitest";
// @ts-expect-error browser module
import { createHubWebClient } from "../src/ui/hub-client.js";
const response = (status: number, body: unknown) => ({ ok: status === 200, status, headers: { get: () => null }, json: async () => body });
function world() {
  let features = ["rooms-v1", "room-owner-requests-v1"], csrf = "scope-one";
  let answer = async () => response(200, { requests: [], choices: [], rooms: [] });
  const fetch = vi.fn(async (path: string, init: any = {}) => path === "/hub/v1/session" ? response(200, {
    signedIn: init.method !== "DELETE", csrf, features,
  }) : answer());
  return { client: createHubWebClient({ fetchImpl: fetch }), fetch, setFeatures: (v: string[]) => { features = v; },
    retire: () => { csrf = "scope-two"; }, answer: (fn: typeof answer) => { answer = fn; } };
}
it("opts into the combined invitation count only after the current session advertises support", async () => {
  const w = world(); await w.client.roomList(); expect(w.fetch.mock.calls.at(-1)?.[0]).toBe("/hub/v1/rooms?v=2");
  await w.client.session(); expect(w.client.ownerRequestsLive()).toBe(true);
  await w.client.roomList(); expect(w.fetch.mock.calls.at(-1)?.[0]).toBe("/hub/v1/rooms?v=2&ownerRequests=1");
  w.setFeatures(["rooms-v1"]); await w.client.session(); expect(w.client.ownerRequestsLive()).toBe(false);
  await w.client.roomList(); expect(w.fetch.mock.calls.at(-1)?.[0]).toBe("/hub/v1/rooms?v=2");
});
it("sends the selected publication and revision through owner-scoped paths, without supplied owner authority", async () => {
  const w = world(); await w.client.session(); w.fetch.mockClear();
  await w.client.ownerAgentRequest("scope-one", "request/one");
  await w.client.acceptOwnerAgentRequest("scope-one", "request/one", { exposureId: "example-agent", revision: 4 });
  await w.client.declineOwnerAgentRequest("scope-one", "request/one");
  expect(w.fetch.mock.calls.map(([path, init]) => [path, init.method, init.body && JSON.parse(init.body)])).toEqual([
    ["/hub/v1/agent-requests/request%2Fone", "GET", undefined],
    ["/hub/v1/agent-requests/request%2Fone/accept", "POST", { exposureId: "example-agent", revision: 4 }],
    ["/hub/v1/agent-requests/request%2Fone/decline", "POST", {}],
  ]);
});
it("discards private choices returned after the session changes", async () => {
  const w = world(); await w.client.session(); let release!: (v: any) => void;
  w.answer(() => new Promise(resolve => { release = resolve; }));
  const pending = w.client.ownerAgentRequest("scope-one", "request");
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  w.retire(); await w.client.signIn("example-person", "example-password");
  release(response(200, { choices: [{ name: "OLD_PRIVATE_CHOICE" }] }));
  expect(await pending).toMatchObject({ ok: false, status: 401 });
  w.fetch.mockClear(); expect(await w.client.acceptOwnerAgentRequest("scope-one", "request", {})).toMatchObject({ status: 401 });
  expect(w.fetch).not.toHaveBeenCalled();
});
it("clears feature support on an ended session and sign-out", async () => {
  const w = world(); await w.client.session(); w.answer(async () => response(401, {}));
  await w.client.ownerAgentRequest("scope-one", "request"); expect(w.client.ownerRequestsLive()).toBe(false);
  await w.client.session(); expect(w.client.ownerRequestsLive()).toBe(true);
  await w.client.signOut(); expect(w.client.ownerRequestsLive()).toBe(false);
});
