/** Clean private member -> company sign-in over owned HTTPS/LDAPS -> production member reconciliation. */
import { afterEach, beforeAll, expect, it, vi } from "vitest";
const dc = vi.hoisted(() => ({ port: 0 }));
vi.mock("node:tls", async original => {
  const real = await original<typeof import("node:tls")>();
  return { ...real, connect: (options: import("node:tls").ConnectionOptions, callback?: () => void) => real.connect({ ...options,
    ...(options.host === "127.0.0.1" && options.port === 636 ? { port: dc.port } : {}),
    ...(options.host === "hub.example.test" ? { host: "127.0.0.1" } : {}) }, callback) };
});
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LookupFunction } from "node:net";
import { companyJoinRig } from "./support/hub-company-join-rig.js";
import { CompanyJoinController } from "../src/hub/join/local.js";
import { CompanyJoinClient } from "../src/hub/join/client.js";
import { currentBinding } from "../src/hub/member/pairing-api.js";
import { createHubMemberFactory } from "../src/hub/compose/member.js";
import { MEMBER_COMPONENTS } from "../src/hub/runtime.js";
import { sha256 } from "../src/hub/identity.js";
const cleanup: Array<() => void | Promise<void>> = [];
beforeAll(async () => { await Promise.all([MEMBER_COMPONENTS.execution!(), MEMBER_COMPONENTS.exposures!()]); });
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const lookup: LookupFunction = (_host, options, callback) => options.all
  ? (callback as unknown as (error: null, addresses: { address: string; family: number }[]) => void)(null, [{ address: "127.0.0.1", family: 4 }])
  : callback(null, "127.0.0.1", 4);

it("a never-paired Fleet joins as Carol and its real member link becomes online before and after reconstruction", async () => {
  const r = await companyJoinRig(port => { dc.port = port; }); cleanup.push(r.close);
  const home = mkdtempSync(join(tmpdir(), "company-recovery-member-")); chmodSync(home, 0o700);
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const admin = await r.signIn("alice"); await r.enable(admin);
  expect((await r.call(admin, "PUT", "/hub/v1/admin/company-join", { enabled: true, expectedRevision: 1 })).status).toBe(200);
  let enabled = false, link = "offline";
  const session = { ownerKey: {}, sessionId: "b".repeat(64), authorityEpoch: 1, hostHere: true, current: () => true };
  const controller = new CompanyJoinController({ home, schedule: false,
    client: new CompanyJoinClient({ ca: readFileSync(r.certs.caCert), lookup }),
    snapshot: () => ({ membership: enabled, binding: existsSync(join(home, "hub-member/state.json")) ? sha256(readFileSync(join(home, "hub-member/state.json"))) : null }),
    enableMembership: (current, accept) => { if (!current()) throw Error("Lost fixture authority"); enabled = true; accept(); },
    activate: () => {}, link: () => link === "online" ? "online" : "offline" });
  cleanup.push(() => controller.close());
  expect(currentBinding(home)).toBeNull();
  const pending = await controller.start({ address: r.webOrigin, label: "Clean Fleet", fleetOrigin: "http://127.0.0.1:4444" }, { session, confirmedCurrent: () => true });
  console.info("clean member probe: Start awaits sign-in");
  const bridge = controller.bridge(pending.operationId, session);
  const opened = await r.call(null, "POST", "/hub/join/open", new URLSearchParams({ requestId: bridge.requestId, state: bridge.state }).toString(),
    { "Content-Type": "application/x-www-form-urlencoded", Origin: "http://127.0.0.1:4444" });
  expect(opened.status).toBe(303);
  const carol = await r.signIn("carol"); carol.cookie += "; " + opened.cookie;
  expect((await r.call(carol, "POST", "/hub/v1/join/approve", { requestId: bridge.requestId })).status).toBe(200);
  expect(await controller.status(pending.operationId, session)).toMatchObject({ state: "saved", issued: true });
  console.info("clean member probe: Carol approved; profile, journal and ACK saved");
  const hubId = currentBinding(home)!.hubId;
  const reports: unknown[] = [];
  const factory = createHubMemberFactory({ home, components: MEMBER_COMPONENTS, boundHub: () => hubId,
    agents: () => [], representative: { deliver: async () => false, agentToken: () => null, attachReports: () => {} },
    attachExposures: () => {}, attachAttention: () => {}, pokeAttention: () => {}, linkState: state => { link = state; },
    notice: () => {}, report: value => { reports.push(value); }, log: () => {} });
  for (const incarnation of [1, 2]) {
    const member = await factory({ enabled: true }, () => true); cleanup.push(() => member.close());
    await member.start(); expect(link, JSON.stringify({ incarnation, reports })).toBe("online");
    console.info("clean member probe: member online", incarnation);
    expect(await controller.status(pending.operationId, session)).toMatchObject({ state: "saved", link: "online" });
    member.fence(); await member.close();
  }
});
