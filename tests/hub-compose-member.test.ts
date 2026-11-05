/**
 * S-51 PR 2b: the member factory over S1's real test rig (a real Hub TLS/WSS server, a real pairing into a private
 * member home), with the real S4 restricted execution and S3c exposure store, and an EMPTY view registry (§7 Q2):
 * the member connects, publishes its (empty) snapshot through #3116's handshake, and nothing is publishable.
 */
import { afterEach, describe, expect, it } from "vitest";
import { statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createHubMemberFactory, memberSet, providerConfig, type HubMemberComponents } from "../src/hub/compose/member.js";
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

function factory(home: string, hubId: string | null, components: HubMemberComponents = MEMBER_COMPONENTS) {
  const reports: { code: string; detail: string }[] = [];
  const attached: { exposures: unknown; attention: unknown; link: string[] } = { exposures: null, attention: null, link: [] };
  const create = createHubMemberFactory({
    home,
    components,
    boundHub: () => hubId,
    agents: () => [{ name: "general", display: "General", providerId: null }],
    attachExposures: (api) => { attached.exposures = api; },
    attachAttention: (read) => { attached.attention = read; },
    pokeAttention: () => {},
    linkState: (state) => { attached.link.push(state); },
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
    // Attached to the fleet: the exposure API (empty registry: nothing to choose, not enforceable) and attention.
    const api = f.attached.exposures as { list(): Array<{ agent: string; choices: { dataViews: unknown[] }; enforceable: boolean }> };
    expect(api.list()).toMatchObject([{ agent: "general", choices: { dataViews: [] }, enforceable: false }]);
    expect(typeof f.attached.attention).toBe("function");
    // The handshake ran on the real link: the Hub saw the member's snapshot.
    for (let i = 0; i < 50 && !rig.received.some((x) => x.type === "exposure.snapshot"); i += 1) await new Promise((r) => setTimeout(r, 50));
    expect(rig.received.some((x) => x.type === "exposure.snapshot")).toBe(true);
    for (let i = 0; i < 50 && !f.attached.link.includes("online"); i += 1) await new Promise((r) => setTimeout(r, 50));
    expect(f.attached.link).toContain("online"); // after the completed #3116 handshake
    service.fence();
    expect(f.attached.link.at(-1)).toBe("offline");
    await service.close();
    expect(f.attached.exposures).toBeNull();
    expect(f.attached.attention).toBeNull();
    // Reopened: the complete set is opened, not recreated.
    const again = await factory(rig.memberHome, hubId).create({ enabled: true }, () => true);
    await again.close();
  });

  it("refuses before any I/O: unpaired (pairing hold), a missing slice (incomplete), a bad provider block", async () => {
    const rig = await paired();
    const hubId = rig.identity.hubId;
    const unpaired = factory(rig.memberHome, null);
    await expect(unpaired.create({ enabled: true }, () => true)).rejects.toThrow(/not paired/);
    expect(unpaired.reports[0]!.code).toBe("hub-member-pairing");
    const missing = factory(rig.memberHome, hubId, { execution: MEMBER_COMPONENTS.execution! });
    await expect(missing.create({ enabled: true }, () => true)).rejects.toThrow(/not in this build/);
    expect(missing.reports[0]!.code).toBe("hub-incomplete");
    const badProvider = factory(rig.memberHome, hubId);
    await expect(badProvider.create({ enabled: true, execution: { provider: { backend: "claude", imageId: "latest", model: "m", credentialRef: "x" } } }, () => true)).rejects.toThrow(/imageId/);
    expect(badProvider.reports[0]!.code).toBe("hub-provider-unavailable");
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
