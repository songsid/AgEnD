/**
 * S-51 PR 2b: the member factory over S1's real test rig (a real Hub TLS/WSS server, a real pairing into a private
 * member home), with the real S4 restricted execution and S3c exposure store, and an EMPTY view registry (§7 Q2):
 * the member connects, publishes its (empty) snapshot through #3116's handshake, and nothing is publishable.
 */
import { afterEach, describe, expect, it } from "vitest";
import { statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createHubMemberFactory, createMemberBinding, createMemberReceive, memberSet, providerConfig, withdrawMemberExposuresOffline, type HubMemberComponents } from "../src/hub/compose/member.js";
import { readFileSync } from "node:fs";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { createHubAudit } from "../src/hub/audit/index.js";
import { HubFileVersionFloor } from "../src/hub/version-floor.js";
import { HubMemberProfileStore } from "../src/hub/profile.js";
import { HubDocumentView } from "../src/hub/execution/index.js";
import { HubExposureStore, publishExposure } from "../src/hub/member/exposures.js";
import { MEMBER_COMPONENTS } from "../src/hub/runtime.js";
import { hubRig } from "./helpers/hub-rig.js";

const rigs: Awaited<ReturnType<typeof hubRig>>[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.close();
});

async function paired() {
  const rig = await hubRig();
  rigs.push(rig);
  await rig.pair();
  return rig;
}

function factory(home: string, hubId: string | null, components: HubMemberComponents = MEMBER_COMPONENTS, providerId: string | null = null) {
  const reports: { code: string; detail: string }[] = [];
  const attached: { exposures: unknown; attention: unknown; link: string[]; notices: { code: string; reason: string }[] } = { exposures: null, attention: null, link: [], notices: [] };
  const create = createHubMemberFactory({
    home,
    components,
    boundHub: () => hubId,
    agents: () => [{ name: "general", display: "General" }],
    attachExposures: (api) => { attached.exposures = api; },
    attachAttention: (read) => { attached.attention = read; },
    pokeAttention: () => {},
    linkState: (state) => { attached.link.push(state); },
    notice: (code, reason) => { attached.notices.push({ code, reason }); },
    report: (code, detail) => reports.push({ code, detail }),
    log: () => {},
  });
  return { create, reports, attached };
}

describe.skipIf(process.platform === "win32")("Hub member factory (S5b PR 2b)", () => {
  it("composes S1 + S4 + S3c on a private member DB, connects, and with no views nothing is publishable", async () => {
    const rig = await paired();
    const hubId = rig.identity.hubId;
    const f = factory(rig.memberHome, hubId);
    const service = await f.create({ enabled: true }, () => true);
    await service.start();
    const set = memberSet(hubId);
    for (const p of [set.database, ...set.floors, ...set.keys]) expect(statSync(join(rig.memberHome, p)).mode & 0o777, p).toBe(0o600);
    const db = new Database(join(rig.memberHome, set.database), { readonly: true });
    expect((db.prepare("SELECT component FROM hub_schema ORDER BY component").all() as { component: string }[]).map((r) => r.component))
      .toEqual(["s1-member-journal", "s3c-exposures", "s4-execution", "s5-audit", "s5-instance"]);
    db.close();
    // Attached to the fleet: the exposure API (P1 representative agent: the agent itself is the one choice) and attention.
    // No delivery path is composed yet (S5's adapter, #3145): nothing is shareable (#3146 r1).
    const api = f.attached.exposures as { list(): Array<{ agent: string; choices: { dataViews: unknown[] }; enforceable: boolean }> };
    expect(api.list()).toMatchObject([{ agent: "general", choices: { dataViews: [{ id: "agent", label: "General" }], tools: [] }, enforceable: false, reason: "delivery_unavailable" }]);
    expect(typeof f.attached.attention).toBe("function");
    // The handshake ran on the real link: the Hub saw the member's snapshot.
    for (let i = 0; i < 50 && !rig.received.some((x) => x.type === "exposure.snapshot"); i += 1) await new Promise((r) => setTimeout(r, 50));
    expect(rig.received.some((x) => x.type === "exposure.snapshot")).toBe(true);
    for (let i = 0; i < 50 && !f.attached.link.includes("online"); i += 1) await new Promise((r) => setTimeout(r, 50));
    expect(f.attached.link).toContain("online"); // after the completed #3116 handshake
    service.fence();
    expect(f.attached.link.at(-1)).toBe("offline");
    expect(f.attached.exposures).toBeNull(); // fence detaches the owner API at once, before any close
    await service.close();
    expect(f.attached.exposures).toBeNull();
    expect(f.attached.attention).toBeNull();
    // Reopened: the complete set is opened, not recreated.
    const again = await factory(rig.memberHome, hubId).create({ enabled: true }, () => true);
    await again.close();
  });

  it("refuses before any I/O: unpaired (pairing hold), a missing slice (incomplete)", async () => {
    const rig = await paired();
    const hubId = rig.identity.hubId;
    const unpaired = factory(rig.memberHome, null);
    await expect(unpaired.create({ enabled: true }, () => true)).rejects.toThrow(/not paired/);
    expect(unpaired.reports[0]!.code).toBe("hub-member-pairing");
    const missing = factory(rig.memberHome, hubId, { execution: MEMBER_COMPONENTS.execution! });
    await expect(missing.create({ enabled: true }, () => true)).rejects.toThrow(/not in this build/);
    expect(missing.reports[0]!.code).toBe("hub-incomplete");
    // None of these created the member state.
    expect(() => statSync(join(rig.memberHome, memberSet(hubId).database))).toThrow();
  });

  it("a partial member set is refused and never recreated", async () => {
    const rig = await paired();
    const hubId = rig.identity.hubId;
    const first = await factory(rig.memberHome, hubId).create({ enabled: true }, () => true);
    await first.close();
    unlinkSync(join(rig.memberHome, memberSet(hubId).floors[2]!));
    const partial = factory(rig.memberHome, hubId);
    await expect(partial.create({ enabled: true }, () => true)).rejects.toThrow(/partial/);
    expect(partial.reports[0]!.code).toBe("hub-state-mismatch");
  });

  it("the provider block is strict and needs the exact private credential path", () => {
    const hubId = "11111111-2222-4333-8444-555555555555";
    expect(providerConfig({}, hubId)).toBeNull();
    const ok = { backend: "codex", imageId: `sha256:${"a".repeat(64)}`, model: "gpt-x", credentialRef: `file:hub-member/${hubId}/secrets/model-api` };
    expect(providerConfig({ execution: { provider: ok } }, hubId)).toEqual(ok);
    for (const bad of [{ ...ok, backend: "grok" }, { ...ok, imageId: "sha256:latest" }, { ...ok, credentialRef: "env:KEY" }, { ...ok, extra: 1 }, { ...ok, dockerSocket: "/tmp/x.sock" }]) {
      expect(() => providerConfig({ execution: { provider: bad } }, hubId), JSON.stringify(bad)).toThrow();
    }
  });
});

describe.skipIf(process.platform === "win32")("member link state", () => {
  it("is reported online only after the #3116 handshake completes, not when the socket opens", async () => {
    const rig = await paired();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    rig.setServerGate(() => held); // the Hub's replies wait: the handshake cannot complete yet
    const f = factory(rig.memberHome, rig.identity.hubId);
    const service = await f.create({ enabled: true }, () => true);
    const starting = service.start().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 400));
    expect(f.attached.link).not.toContain("online");
    rig.setServerGate(undefined);
    release();
    for (let i = 0; i < 60 && !f.attached.link.includes("online"); i += 1) await new Promise((r) => setTimeout(r, 50));
    expect(f.attached.link).toContain("online");
    await starting;
    await service.close();
  });
});

describe.skipIf(process.platform === "win32")("provider setup is non-fatal (agreed with S4b)", () => {
  const good = (hubId: string) => ({ backend: "claude", imageId: `sha256:${"b".repeat(64)}`, model: "m-1", credentialRef: `file:hub-member/${hubId}/secrets/model-api` });
  it("a bad block, a missing credential or a missing S4b: the member runs with no provider and one hold with the bounded reason", async () => {
    const rig = await paired();
    const hubId = rig.identity.hubId;
    const cases: [string, Record<string, unknown>, HubMemberComponents, string][] = [
      ["bad image", { ...good(hubId), imageId: "latest" }, MEMBER_COMPONENTS, "image-unconfigured"],
      ["bad credentialRef", { ...good(hubId), credentialRef: "env:KEY" }, MEMBER_COMPONENTS, "credential-unconfigured"],
      ["missing credential file", good(hubId), MEMBER_COMPONENTS, "credential-unconfigured"],
      ["no S4b in the build", good(hubId), { execution: MEMBER_COMPONENTS.execution!, exposures: MEMBER_COMPONENTS.exposures! }, "unavailable"],
    ];
    for (const [label, provider, components, reason] of cases) {
      const f = factory(rig.memberHome, hubId, components, "claude");
      const service = await f.create({ enabled: true, execution: { provider } }, () => true);
      await service.start();
      expect(f.attached.notices, label).toEqual([{ code: "hub-provider-unavailable", reason }]);
      // S4 sees the same bounded reason (presentation only).
      expect((service as unknown as { providerReason(id: string): unknown }).providerReason("claude"), label).toBe(reason);
      expect(f.reports, label).toEqual([]); // not fatal
      const api = f.attached.exposures as { list(): Array<{ enforceable: boolean; reason?: string }> };
      // P1 representative agent: the container provider's state is not the reason any more (the hold stays S5's); with no
      // delivery path composed the agent is unshareable for that reason alone.
      expect(api.list(), label).toMatchObject([{ enforceable: false, reason: "delivery_unavailable" }]);
      await service.close();
    }
  });
});

describe.skipIf(process.platform === "win32")("#3130 review: disconnect, routing and binding", () => {
  it("held at disconnect: published exposures are withdrawn in the member's own store; the same Hub republishes nothing", async () => {
    const rig = await paired();
    const hubId = rig.identity.hubId;
    const set = memberSet(hubId);
    const first = await factory(rig.memberHome, hubId).create({ enabled: true }, () => true); // creates the member state
    await first.close();
    // The owner had published one exposure before the member was held.
    const profile = new HubMemberProfileStore(rig.memberHome, hubId).readProfile();
    const view = new HubDocumentView("handbook", [{ id: "d1", title: "Handbook", text: "text" }]);
    const db = new Database(join(rig.memberHome, set.database));
    const audit = createHubAudit({ db, contentKey: Buffer.from(readFileSync(join(rig.memberHome, set.keys[1]!), "utf8").trim(), "base64") });
    const store = new HubExposureStore(db, { floor: new HubFileVersionFloor(rig.memberHome, set.floors[2]!), audit, binding: () => ({ owner: profile.owner, fleetId: profile.fleetId }), views: new Map([["handbook", view]]) });
    publishExposure(store, { agent: "general", providerId: "claude", displayName: "General", dataViewId: "handbook", allowedTools: ["documents.read"], expectedRevision: 0 },
      (c) => ({ ok: true, policyDigest: c.exposure.policyDigest, exposureRevision: c.exposure.revision }));
    expect(store.snapshot().exposures).toHaveLength(1);
    db.close();

    expect(await withdrawMemberExposuresOffline(rig.memberHome, hubId)).toBe(1);
    expect(await withdrawMemberExposuresOffline(rig.memberHome, hubId)).toBe(0); // idempotent

    // Re-composed for the same Hub: nothing is published, so the snapshot it sends carries nothing.
    const again = factory(rig.memberHome, hubId);
    const service = await again.create({ enabled: true }, () => true);
    const db2 = new Database(join(rig.memberHome, set.database), { readonly: true });
    const rows = db2.prepare("SELECT committed FROM hub_exposures").all() as { committed: string }[];
    db2.close();
    expect(rows.map((r) => JSON.parse(r.committed).exposure.state)).toEqual(["withdrawn"]);
    await service.close();
    // Never composed: nothing to withdraw. Partial state: refused, so the disconnect reports "unsaved".
    expect(await withdrawMemberExposuresOffline(rig.memberHome, "11111111-2222-4333-8444-555555555555")).toBe(0);
    unlinkSync(join(rig.memberHome, set.floors[0]!));
    await expect(withdrawMemberExposuresOffline(rig.memberHome, hubId)).rejects.toThrow(/partial/);
  });

  it("receive: a question's receipt answers that question's requestId; revoke fences; the Hub's receipt is acknowledged", async () => {
    const sent: any[] = [];
    const receipt = { messageId: randomUUID(), contentDigest: "c".repeat(64), stage: "queued", sequence: 1 } as never;
    const calls: string[] = [];
    const receive = createMemberReceive({
      admission: { admit: async () => receipt, fence: async () => { calls.push("fence"); } },
      journal: { acknowledge: () => { calls.push("ack"); } },
      live: () => true,
      log: () => {},
    });
    const link = { linkEpoch: 7, revocationVersion: 0, current: () => true, send: async (f: unknown) => { sent.push(f); }, exchange: async () => ({}) } as any;
    await receive({ v: 1, type: "question", requestId: "q-req-123", linkEpoch: 7, payload: {} } as any, link);
    expect(sent).toEqual([{ v: 1, type: "receipt", requestId: "q-req-123", linkEpoch: 7, payload: receipt }]);
    await receive({ v: 1, type: "revoke", requestId: "r", linkEpoch: 7, payload: {} } as any, link);
    await receive({ v: 1, type: "receipt", requestId: "a", linkEpoch: 7, payload: receipt } as any, link);
    expect(calls).toEqual(["fence", "ack"]);
    await expect(receive({ v: 1, type: "authorize.result", requestId: "x", linkEpoch: 7, payload: {} } as any, link)).rejects.toThrow(/unexpected/);
    const stale = { ...link, current: () => false };
    await receive({ v: 1, type: "question", requestId: "q2", linkEpoch: 7, payload: {} } as any, stale);
    expect(sent).toHaveLength(1);
  });

  it("binding: every (re)link starts a new generation; a binding captured earlier reads current() === false, as after fence", () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const profile = { issuerKeyId: "k".repeat(64), fleetId: randomUUID(), owner: { realm: "corp", objectId: randomUUID() }, hub: { issuerPublicKey: publicKey.export({ type: "spki", format: "pem" }).toString() } } as any;
    const b = createMemberBinding({ hubId: randomUUID(), profile, live: () => true, revocationFloor: () => 0 });
    const linkA = { linkEpoch: 1, revocationVersion: 0, current: () => true } as any;
    const linkB = { linkEpoch: 2, revocationVersion: 0, current: () => true } as any;
    const before = b.binding();
    expect(before.current()).toBe(true);
    b.relink(linkA);
    expect(before.current()).toBe(false);
    const onA = b.binding();
    expect(onA.generation).toBeGreaterThan(before.generation);
    expect(onA.linkEpoch).toBe(1);
    expect(onA.current()).toBe(true);
    b.relink(linkB);
    expect(onA.current()).toBe(false); // re-link: old work is fenced
    const onB = b.binding();
    expect(onB.generation).toBeGreaterThan(onA.generation);
    b.fence();
    expect(onB.current()).toBe(false);
  });
});
