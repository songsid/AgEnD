/** Actual member factory, on-disk legacy state and pinned TLS/WSS; agent input and Hub policy answers are inert. */
import Database from "better-sqlite3";
import { createPrivateKey, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { hubRig } from "./helpers/hub-rig.js";
import { createHubMemberFactory, memberSet } from "../src/hub/compose/member.js";
import { MEMBER_COMPONENTS } from "../src/hub/runtime.js";
import { operationDigest, sha256, signAsker } from "../src/hub/identity.js";
import type { HubMemberExposureApi } from "../src/hub/member/exposure-api.js";
import type { HubRepresentativeExecution, HubRepresentativeDelivery } from "../src/hub/representative.js";
import type { HubMountedService } from "../src/hub/mount.js";
import type { HubQuestion } from "../src/hub/types.js";

it("#3878: reopens an alpha.3 held question, reconnects, and answers new work once without replaying the hold", async () => {
  const r = await hubRig(); let service: HubMountedService | undefined;
  const attempts: HubRepresentativeDelivery[] = [], inputs: HubRepresentativeDelivery[] = [], answers: string[] = [];
  let api: HubMemberExposureApi | null = null, refuseBegin = true, epoch = 0;
  const links: string[] = [];
  try {
    const profile = await r.pair();
    r.setReceive(async (frame, link) => {
      epoch = link.linkEpoch;
      const common = { v: 1 as const, requestId: frame.requestId, linkEpoch: link.linkEpoch };
      if (frame.type === "reconcile") return { ...common, type: "reconcile", payload: { receipts: [], nextReceiptSequence: 0, more: false } };
      if (frame.type === "receipt") return { ...common, type: "receipt", payload: frame.payload };
      if (frame.type === "authorize.request") {
        if (refuseBegin && frame.payload.phase === "begin") return { ...common, type: "authorize.result", payload: { ok: false, reasonCode: "unavailable" } };
        return { ...common, type: "authorize.result", payload: { ok: true, lease: { decisionId: randomUUID(), messageId: frame.payload.messageId,
          operationId: frame.payload.operationId, phase: frame.payload.phase, operationDigest: operationDigest(frame.payload),
          exposureRevision: frame.payload.exposureRevision, revocationVersion: r.store.read().revocationVersion, linkEpoch: link.linkEpoch, expiresAt: Date.now() + 5_000 } } };
      }
      if (frame.type === "answer") {
        answers.push(frame.payload.messageId);
        return { ...common, type: "receipt", payload: { messageId: frame.payload.messageId, contentDigest: frame.payload.contentDigest, stage: "answered", sequence: 1, at: Date.now() } };
      }
    });
    const create = createHubMemberFactory({ home: r.memberHome, components: MEMBER_COMPONENTS, boundHub: () => r.identity.hubId,
      agents: () => [{ name: "probe", display: "Probe" }], representative: {
        agentToken: agent => agent === "probe" ? "owned-generation" : null, attachReports() {},
        deliver: async input => { attempts.push(input); const ok = await input.beforeInput(); if (ok) inputs.push(input); return ok; },
      }, attachExposures: value => { api = value; }, attachAttention() {}, pokeAttention() {},
      linkState: value => links.push(value), report() {}, log() {} });
    service = await create({}, () => true); await service.start();
    const published = api!.publish({ agent: "probe", dataViewId: "agent", tools: [], expectedRevision: 0 });
    const key = createPrivateKey(readFileSync(join(r.root, "hub/keys/issuer-key.pem")));
    const question = (): HubQuestion => ({ text: "Owned upgrade fixture", identity: signAsker({ v: 1, issuer: r.identity.hubId,
      issuerKeyId: r.identity.issuerKeyId, messageId: randomUUID(), asker: r.owner, owner: r.owner, destinationFleetId: profile.fleetId,
      exposureId: published.exposureId!, exposureRevision: published.revision, roomId: randomUUID(), grantId: randomUUID(), grantRevision: 1,
      revocationVersion: r.store.read().revocationVersion, contentDigest: sha256("Owned upgrade fixture"), issuedAt: Date.now(),
      expiresAt: Date.now() + 120_000, nonce: randomBytes(32).toString("hex") }, key) });
    const held = question();
    await r.server.send(profile.fleetId, { v: 1, type: "question", requestId: randomUUID(), linkEpoch: epoch, payload: held });
    const path = join(r.memberHome, memberSet(r.identity.hubId).database);
    const readState = () => { const db = new Database(path, { readonly: true });
      try { return db.prepare("SELECT state FROM hub_representative_questions WHERE message_id=?").get(held.identity.messageId); } finally { db.close(); } };
    await vi.waitFor(() => expect(readState()).toEqual({ state: "held" }));
    expect(inputs).toHaveLength(0); await service.close(); service = undefined;
    // The alpha.3 format predates pairing binding; preserve all durable question/consent/floor bytes.
    const old = new Database(path);
    const before = old.prepare("SELECT * FROM hub_representative_questions").all();
    const message = old.prepare("SELECT * FROM hub_member_messages").all();
    old.exec("ALTER TABLE hub_member_meta DROP COLUMN binding");
    old.prepare("UPDATE hub_schema SET version=1 WHERE component='s1-member-journal'").run(); old.close();
    links.length = 0; refuseBegin = false;
    service = await create({}, () => true); await service.start();
    await vi.waitFor(() => expect(links).toContain("online"));
    const upgraded = new Database(path, { readonly: true });
    try { expect(upgraded.prepare("SELECT * FROM hub_representative_questions").all()).toEqual(before);
      expect(upgraded.prepare("SELECT value FROM hub_member_messages").all()).toEqual(message.map(row => ({ value: (row as { value: string }).value })));
      expect(upgraded.prepare("SELECT binding IS NOT NULL AS bound FROM hub_member_meta").get()).toEqual({ bound: 1 });
    } finally { upgraded.close(); }
    expect(attempts).toHaveLength(1); expect(inputs).toHaveLength(0);
    const next = question();
    await r.server.send(profile.fleetId, { v: 1, type: "question", requestId: randomUUID(), linkEpoch: epoch, payload: next });
    await vi.waitFor(() => expect(inputs).toHaveLength(1));
    const rep = (service as unknown as { representative: HubRepresentativeExecution }).representative;
    expect(await rep.report({ correlationId: inputs[0]!.correlationId, caller: "probe", text: "Owned answer" })!).toMatchObject({ ok: true });
    const replayId = randomUUID();
    await r.server.send(profile.fleetId, { v: 1, type: "question", requestId: replayId, linkEpoch: epoch, payload: next });
    await vi.waitFor(() => expect(r.received.some(frame => frame.type === "receipt" && frame.requestId === replayId && frame.payload.messageId === next.identity.messageId)).toBe(true));
    expect(inputs).toHaveLength(1); expect(answers).toEqual([next.identity.messageId]); expect(readState()).toEqual({ state: "held" });
  } finally { await service?.close(); await r.close(); }
});
