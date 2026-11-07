import Database from "better-sqlite3";
import { createServer as netServer } from "node:net";
import { mkdtempSync, mkdirSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { provisionHubIdentity } from "../../src/hub/tls.js";
import { HubTransportStore, migrateHubTransportStore } from "../../src/hub/store.js";
import { HubPairingService } from "../../src/hub/pairing.js";
import { HubServer, type HubServerOptions } from "../../src/hub/server.js";
import { beginHubPairing, claimHubPairing } from "../../src/hub/pairing-client.js";
import { HubMemberProfileStore } from "../../src/hub/profile.js";
import { HubMemberClient, type HubMemberLink } from "../../src/hub/client.js";
import { operationDigest } from "../../src/hub/identity.js";
import type { HubDirectory, HubRequestContext, HubMemberFrame } from "../../src/hub/types.js";
export async function freeHubPort(): Promise<number> {
  const server = netServer(); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port; await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
export async function hubRig(options: { serverCapabilities?: readonly string[]; clientCapabilities?: readonly string[] } = {}) {
  mkdirSync(".artifacts", { recursive: true }); const root = mkdtempSync(join(process.cwd(), ".artifacts/hub-net-test-")); chmodSync(root, 0o700);
  const memberHome = join(root, "member"); mkdirSync(memberHome, { mode: 0o700 }); const port = await freeHubPort();
  const memberOrigin = `https://127.0.0.1:${port}`, identity = await provisionHubIdentity({ home: root, memberOrigin });
  const owner = { realm: "directory", objectId: randomUUID() }; let eligible = true, enabled = true, floor = 0;
  const directory: HubDirectory = { realm: "directory", signIn: async () => ({ ok: false, reason: "invalid-credentials" }), checkEligibility: async () => eligible ? { eligible: true, person: { key: owner, login: "owner", dn: "private", groups: [] } } : { eligible: false, reason: "disabled" }, close: async () => {} };
  const ctx: HubRequestContext = { requestId: randomUUID(), current: async () => ({ kind: "directory", person: owner, sessionId: randomUUID() }), requirePerson: async () => owner, requireAdmin: async () => ({ kind: "local-host", sessionId: randomUUID(), directoryBinding: owner }) };
  const db = new Database(join(root, "test.sqlite")); chmodSync(join(root, "test.sqlite"), 0o600); db.exec("CREATE TABLE audit (value TEXT)"); migrateHubTransportStore(db);
  const store = new HubTransportStore(db, { floor: { read: () => floor, raise: n => { floor = n; } }, appendAudit: (value, tx) => { tx.prepare("INSERT INTO audit VALUES(?)").run(JSON.stringify(value)); } }); store.initialize();
  const received: HubMemberFrame[] = [], holds: Array<{ fleet: string | null; code: string }> = [];
  let server!: HubServer;
  const pairing = new HubPairingService({ store, directory, identity: { ...identity, memberOrigin, webOrigin: `https://127.0.0.1:${port + 1}` }, enabled: () => enabled, fenceFleet: (id, reason) => server?.fenceFleet(id, reason), refreshAuthorization: () => server?.refreshAuthorization() });
  let serverGate: (() => Promise<void>) | undefined;
  let receiver: HubServerOptions["receive"] | undefined;
  server = new HubServer({ home: root, hubId: identity.hubId, memberOrigin, listen: { host: "127.0.0.1", port }, pairing, capabilities: options.serverCapabilities,
    current: () => enabled, hold: (fleet, code) => holds.push({ fleet, code }), receive: async (frame, link) => {
      received.push(frame); await serverGate?.(); if (!link.current()) return;
      if (receiver) return receiver(frame, link);
      const common = { v: 1 as const, requestId: frame.requestId, linkEpoch: link.linkEpoch };
      if (frame.type === "reconcile") return { ...common, type: "reconcile", payload: { receipts: [], nextReceiptSequence: 0, more: false } };
      if (frame.type === "authorize.request") return { ...common, type: "authorize.result", payload: { ok: true, lease: { decisionId: randomUUID(), messageId: frame.payload.messageId, operationId: frame.payload.operationId, phase: frame.payload.phase,
        operationDigest: operationDigest(frame.payload), exposureRevision: frame.payload.exposureRevision, revocationVersion: store.read().revocationVersion, linkEpoch: link.linkEpoch, expiresAt: Date.now() + 5_000 } } };
    } }); await server.start();
  const clients: HubMemberClient[] = [];
  const pair = async (home = memberHome) => {
    const offer = await pairing.create(ctx, owner);
    const pending = await beginHubPairing({ home, memberOrigin, code: offer.code, current: () => enabled });
    await pairing.confirmOwner(ctx, pending.pairingId, pending.fingerprint); await pairing.approve(ctx, pending.pairingId, pending.fingerprint);
    await claimHubPairing({ home, hubId: identity.hubId, approvedFingerprint: pending.fingerprint, expectedProfileDigest: null, current: () => enabled });
    return new HubMemberProfileStore(home, identity.hubId).readProfile();
  };
  /** `capabilities`: the optional features this member offers ([] stands in for an older member). */
  const client = (onFrame: (frame: any, link: HubMemberLink) => Promise<void> = async () => {}, reconcileGate?: () => Promise<void>, capabilities?: readonly string[], home = memberHome) => {
    const state: { link: HubMemberLink | null; holds: string[]; syncs: number } = { link: null, holds: [], syncs: 0 };
    const value = new HubMemberClient({ home, hubId: identity.hubId, memberOrigin, current: () => enabled, capabilities: capabilities ?? options.clientCapabilities,
      reconcile: async link => { state.link = link; state.syncs++; await link.exchange({ v: 1, type: "reconcile", requestId: randomUUID(), linkEpoch: link.linkEpoch, payload: { afterReceiptSequence: 0, messages: [] } }, "reconcile"); await reconcileGate?.(); }, receive: onFrame,
      hold: code => state.holds.push(code), random: () => 0 }); clients.push(value); return { value, state };
  };
  return { root, memberHome, memberOrigin, identity, owner, directory, db, store, pairing, ctx, server, received, holds, pair, client,
    disableOwner: () => { eligible = false; }, disable: () => { enabled = false; }, setServerGate: (gate?: () => Promise<void>) => { serverGate = gate; },
    setReceive: (receive: HubServerOptions["receive"]) => { receiver = receive; },
    close: async () => { for (const c of clients) await c.close(); await server.close(); db.close(); rmSync(root, { recursive: true, force: true }); } };
}
