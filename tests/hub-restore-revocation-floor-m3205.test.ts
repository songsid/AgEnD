/**
 * M-3205: a Hub restored from a backup holds a LOWER authorization version than its Fleets have already seen (a revocation
 * after the backup, or 2.4.0-beta.9's roles cutover, which raises it once on the upgraded Hub). Every Fleet then refused
 * the restored Hub's welcome as stale and stayed held for good. The member now sends its durable floor on the connect
 * upgrade; the Hub, after authenticating the credential, catches its version UP to that floor (never down, bounded,
 * audited), so the Fleets reconnect by themselves with their shares and grants. Leases issued at older versions stay refused.
 */
import { afterEach, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { request } from "node:https";
import { hubRig } from "./helpers/hub-rig.js";
import { createHubMemberFactory } from "../src/hub/compose/member.js";
import { MEMBER_COMPONENTS } from "../src/hub/runtime.js";
import { HUB_PATHS, HUB_REVOCATION_CATCH_UP_MAX, HUB_REVOCATION_FLOOR_HEADER } from "../src/hub/protocol.js";
import { HubMemberProfileStore } from "../src/hub/profile.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

type Rig = Awaited<ReturnType<typeof hubRig>>;
const setVersion = (r: Rig, version: number, action = "rig.version") =>
  r.store.mutate({ at: Date.now(), requestId: randomUUID(), actor: { kind: "local-host" }, action, result: "completed" }, s => { s.revocationVersion = version; });
const audits = (r: Rig) => (r.db.prepare("SELECT value FROM audit").all() as { value: string }[]).map(x => JSON.parse(x.value) as { action: string; fleetId?: string });

it("a member that saw a newer version catches a restored Hub up and comes back online (same process: its in-memory floor)", async () => {
  const r = await hubRig(); cleanup.push(r.close);
  await r.pair();
  const c = r.client(); await c.value.start();
  expect(c.state.link?.revocationVersion).toBe(0);
  // An authorization change after the backup (or the upgrade's roles cutover): the member observes version 3.
  let epoch = c.state.link!.linkEpoch;
  setVersion(r, 3); r.server.refreshAuthorization();
  await vi.waitFor(() => expect(c.state.link!.linkEpoch !== epoch && c.state.link!.revocationVersion === 3 && c.state.link!.current()).toBe(true), { timeout: 15_000 });
  epoch = c.state.link!.linkEpoch;
  // The restore: the Hub's version goes back to the backup's 1.
  setVersion(r, 1, "rig.restore"); r.server.refreshAuthorization();
  await vi.waitFor(() => expect(c.state.link!.linkEpoch !== epoch && c.state.link!.revocationVersion === 3 && c.state.link!.current()).toBe(true), { timeout: 15_000 });
  expect(r.store.read().revocationVersion).toBe(3);
  const fleetId = new HubMemberProfileStore(r.memberHome, r.identity.hubId).readProfile().fleetId;
  expect(audits(r).filter(a => a.action === "member.revocation-caught-up")).toEqual([expect.objectContaining({ fleetId })]);
  expect(c.state.holds.filter(h => h === "key-changed" || h === "rejected")).toEqual([]);
});

it("a fresh member process sends its journal floor; without the floor (an older member) the Hub stays where it is", async () => {
  const r = await hubRig(); cleanup.push(r.close);
  await r.pair(); setVersion(r, 2);
  // An older member (no floor option, new process): connects at the Hub's own version, nothing is raised.
  const old = r.client(); await old.value.start(); expect(old.state.link?.revocationVersion).toBe(2); await old.value.close();
  expect(r.store.read().revocationVersion).toBe(2);
  // This member's journal says 7 (what it saw before the restore).
  const fresh = r.client(); (fresh.value as any).options.revocationFloor = () => 7;
  await fresh.value.start();
  expect(fresh.state.link?.revocationVersion).toBe(7); expect(r.store.read().revocationVersion).toBe(7);
  // A floor at or below the Hub's version changes nothing.
  await fresh.value.close();
  const same = r.client(); (same.value as any).options.revocationFloor = () => 5; await same.value.start();
  expect(r.store.read().revocationVersion).toBe(7);
  expect(audits(r).filter(a => a.action === "member.revocation-caught-up")).toHaveLength(1);
});

const upgrade = (r: Rig, headers: Record<string, string>) => new Promise<number>(resolve => {
  const url = new URL(HUB_PATHS.connect, r.memberOrigin);
  const req = request({ host: url.hostname, port: Number(url.port), path: url.pathname, method: "GET", rejectUnauthorized: false,
    headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": randomBytes(16).toString("base64"), ...headers } });
  req.on("upgrade", (_res, socket) => { socket.destroy(); resolve(101); });
  req.on("response", res => { res.resume(); resolve(res.statusCode ?? 0); });
  req.on("error", () => resolve(0)); req.end();
});

it("only an authenticated member moves the version, only upward, within the bound, and a malformed floor is ignored", async () => {
  const r = await hubRig(); cleanup.push(r.close);
  const profile = await r.pair(); setVersion(r, 4);
  const auth = { Authorization: `Bearer ${profile.credential}` };
  // No credential / a wrong one: refused before any catch-up.
  await upgrade(r, { [HUB_REVOCATION_FLOOR_HEADER]: "50" });
  await upgrade(r, { Authorization: `Bearer ${"0".repeat(64)}`, [HUB_REVOCATION_FLOOR_HEADER]: "50" });
  expect(r.store.read().revocationVersion).toBe(4);
  // Malformed, negative, beyond the bound: ignored (the link itself still connects at the Hub's version).
  for (const bad of ["abc", "-9", "1e9", "9".repeat(16), String(4 + HUB_REVOCATION_CATCH_UP_MAX + 1)]) {
    expect(await upgrade(r, { ...auth, [HUB_REVOCATION_FLOOR_HEADER]: bad })).toBe(101);
    expect(r.store.read().revocationVersion).toBe(4);
  }
  // Lower: never down.
  await upgrade(r, { ...auth, [HUB_REVOCATION_FLOOR_HEADER]: "1" }); expect(r.store.read().revocationVersion).toBe(4);
  // At the bound: raised.
  await upgrade(r, { ...auth, [HUB_REVOCATION_FLOOR_HEADER]: String(4 + HUB_REVOCATION_CATCH_UP_MAX) });
  expect(r.store.read().revocationVersion).toBe(4 + HUB_REVOCATION_CATCH_UP_MAX);
});

it("the composed member (journal floor) reconnects to a restored Hub by itself — the rig's beta.9 case", async () => {
  const r = await hubRig(); cleanup.push(r.close);
  const home = join(r.root, "fleet"); mkdirSync(home, { mode: 0o700 });
  await r.pair(home);
  writeFileSync(join(home, "hub-member/state.json"), JSON.stringify({ hubId: r.identity.hubId }), { mode: 0o600 });
  let state = "offline";
  const member = () => createHubMemberFactory({ home, components: MEMBER_COMPONENTS, boundHub: () => r.identity.hubId,
    agents: () => [], representative: { deliver: async () => false, agentToken: () => null, attachReports: () => {} },
    attachExposures: () => {}, attachAttention: () => {}, pokeAttention: () => {},
    linkState: next => { state = next; }, notice: () => {}, report: () => {}, log: () => {} });
  let reconciles = 0;
  r.setReceive(async (frame, link) => frame.type === "reconcile" && ++reconciles ? { v: 1, type: "reconcile", requestId: frame.requestId,
    linkEpoch: link.linkEpoch, payload: { receipts: [], nextReceiptSequence: 0, more: false } } : undefined);
  const first = await member()({ enabled: true }, () => true); cleanup.push(() => first.close());
  await first.start(); expect(state).toBe("online");
  // The upgraded Hub's one-time change (2.4.0-beta.9 roles cutover): 0 → 1, seen by the Fleet.
  const seen = reconciles; setVersion(r, 1, "role.migrated"); r.server.refreshAuthorization();
  await vi.waitFor(() => expect(reconciles > seen && state === "online").toBe(true), { timeout: 15_000 });
  first.fence(); await first.close();
  // Restore the pre-upgrade backup: the Hub's version is 0 again. The Fleet process restarts.
  setVersion(r, 0, "rig.restore");
  const second = await member()({ enabled: true }, () => true); cleanup.push(() => second.close());
  state = "offline"; await second.start();
  await vi.waitFor(() => expect(state).toBe("online"), { timeout: 15_000 });
  expect(r.store.read().revocationVersion).toBe(1);
});
