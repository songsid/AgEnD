import { expect, it, vi } from "vitest";
// @ts-expect-error browser module
import { createHubWebClient } from "../src/ui/hub-client.js";
const response = (status: number, body: unknown) => ({ ok: status === 200, status, headers: { get: () => null }, json: async () => body });
function fixture() {
  let csrf = "scope-one", feature = true, reply = async () => response(200, { candidates: [], findable: false });
  const fetch = vi.fn(async (path: string, input: any = {}) => path === "/hub/v1/session" ? response(200, { signedIn: input.method !== "DELETE", csrf, features: feature ? ["room-agent-discovery-v1"] : [] }) : reply());
  return { c: createHubWebClient({ fetchImpl: fetch }), fetch, legacy: () => { feature = false; }, retire: () => { csrf = "scope-two"; }, answer: (fn: typeof reply) => { reply = fn; } };
}
it("requests discovery only for a supported session's agent picker, not person pickers or older Hubs", async () => {
  const f = fixture(); await f.c.session(); await f.c.roomCandidates("Example", "agent");
  expect(f.fetch.mock.calls.at(-1)?.[0]).toContain("discovery=1");
  await f.c.roomCandidates("Example", "person"); expect(f.fetch.mock.calls.at(-1)?.[0]).not.toContain("discovery=");
  f.legacy(); await f.c.session(); await f.c.roomCandidates("Example", "agent");
  expect(f.fetch.mock.calls.at(-1)?.[0]).not.toContain("discovery=");
});
it("sends a scoped publication and preference revision and refuses retired-scope writes", async () => {
  const f = fixture(); await f.c.session();
  await f.c.agentRoomDiscovery("scope-one", "agent/one", { findable: true, exposureRevision: 3, ifRevision: 2 });
  const [path, input] = f.fetch.mock.calls.at(-1)!;
  expect(path).toBe("/hub/v1/exposures/agent%2Fone/room-discovery");
  expect(input.headers["X-AgEnD-Hub-CSRF"]).toBe("scope-one");
  expect(JSON.parse(input.body)).toEqual({ findable: true, exposureRevision: 3, ifRevision: 2 });
  f.retire(); await f.c.signIn("example-person", "example-password"); f.fetch.mockClear();
  expect(await f.c.agentRoomDiscovery("scope-one", "agent", {})).toMatchObject({ status: 401 }); expect(f.fetch).not.toHaveBeenCalled();
});
it("discards an old-session settings response and clears discovery support on sign-out", async () => {
  const f = fixture(); await f.c.session(); let release!: (r: any) => void;
  f.answer(() => new Promise(resolve => { release = resolve; }));
  const pending = f.c.agentRoomDiscovery("scope-one", "agent"); await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  f.retire(); await f.c.signIn("example-person", "example-password");
  release(response(200, { findable: true, private: "OLD_SETTING" }));
  const result = await pending; expect(result).toMatchObject({ status: 401 }); expect(JSON.stringify(result)).not.toContain("OLD_SETTING");
  await f.c.signOut(); expect(f.c.roomDiscoveryLive()).toBe(false);
});
