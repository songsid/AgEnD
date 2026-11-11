/** Local cancellation and strict profile/journal settlement must win independently of the short Settings transaction. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { signCompanyInvitation } from "../src/hub/join/invitation.js";
import { parseCompanyAddress } from "../src/hub/join/descriptor.js";
import { createPrivateKey } from "node:crypto";
import { ENROLMENT_CODE, normalEnrolmentCode, CompanyJoinController } from "../src/hub/join/local.js";
import { currentLocalJoinId, readLocalJoin } from "../src/hub/join/local-journal.js";
import { currentBinding, createHubMemberPairingApi } from "../src/hub/member/pairing-api.js";
import { provisionHubIdentity } from "../src/hub/tls.js";
import { sha256 } from "../src/hub/identity.js";
import { companyIdentityDigest } from "../src/hub/join/protocol.js";
import { createJoinPrivate, writeJoinPrivate } from "../src/hub/join/private.js";
import { HubMemberProfileStore } from "../src/hub/profile.js";
const homes: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const p of homes.splice(0)) rmSync(p, { force: true, recursive: true }); });
const home = () => { const p = mkdtempSync(join(tmpdir(), "agend-local-join-")); chmodSync(p, 0o700); homes.push(p); return p; };
async function world() {
  const directory = home(), hubHome = home(), identity = await provisionHubIdentity({ home: hubHome, memberOrigin: "https://hub.example.test:9443" });
  const { hubId, spkiSha256, issuerPublicKey } = identity;
  const hub = { hubId, spkiSha256, issuerPublicKey, memberOrigin: "https://hub.example.test:9443", webOrigin: "https://hub.example.test" };
  const metadata = { v: 1 as const, hub, identityDigest: companyIdentityDigest(hub), certificatePem: readFileSync(join(hubHome, "hub/keys/tls-cert.pem"), "utf8"), features: ["company-join-v1"] };
  let alive = true, confirmed = true, stamp = "initial", enabled = false, remote = "pending", now = Date.now(), settleFailure = false;
  const owner = { realm: "corp", objectId: randomUUID() }, credential = "a".repeat(64), calls: string[] = [];
  const session = { ownerKey: {}, sessionId: "b".repeat(64), authorityEpoch: 1, hostHere: true, current: () => alive };
  const authority = { session, confirmedCurrent: () => confirmed };
  const client = { discover: vi.fn(async () => metadata), command: vi.fn(async (binding: any, purpose: string) => {
    calls.push(purpose);
    const status = { state: remote, reason: null, issued: ["issued", "acknowledged"].includes(remote), fleetId: remote === "pending" ? null : binding.fleetId,
      generation: remote === "pending" ? null : 1, outerDeadline: now + 600_000, redeemDeadline: now + 60_000, deliveryDeadline: now + 120_000 };
    if (purpose === "push") return { requestId: binding.requestId, expiresAt: now + 600_000, browserAction: hub.webOrigin + "/hub/join/open" };
    if (purpose === "redeem") { remote = "issued"; return { ...status, state: "issued", issued: true, fleetId: binding.fleetId, generation: 1, owner, credential, hub, certificatePem: metadata.certificatePem }; }
    if (purpose === "ack") { remote = "acknowledged"; return { ...status, state: remote }; }
    if (purpose === "cancel") { remote = "undeliverable"; return { ...status, state: remote }; }
    return status;
  }) };
  const activate = vi.fn();
  const options = { home: directory, client, now: () => now, schedule: false as const, snapshot: () => ({ membership: enabled, binding: stamp === "replacement" ? "e".repeat(64) : (() => { try { return sha256(readFileSync(join(directory, "hub-member/state.json"), "utf8")); } catch { return null; } })() }),
    link: () => "offline" as const, activate,
    enableMembership: (current: () => boolean, accept: () => void) => { if (!current()) throw Error("lost"); if (settleFailure) throw Error("disk"); enabled = true; stamp = "enabled"; accept(); } };
  const controller = new CompanyJoinController(options);
  const start = () => controller.start({ address: hub.webOrigin, label: "My Fleet", fleetOrigin: "http://127.0.0.1:4444" }, authority);
  return { directory, hubHome, metadata, calls, client, session, authority, controller, options, activate, start,
    ready: () => { remote = "identity-approved"; }, lose: () => { alive = false; }, deny: () => { confirmed = false; }, replace: () => { stamp = "replacement"; },
    diskFailure: (value: boolean) => { settleFailure = value; }, advance: (ms: number) => { now += ms; }, enabled: () => enabled };
}
describe("Fleet local company join", () => {
  it.each([false, true])("an expired unissued abandonment allows a new session to Start without cleanup (restart %s)", async restart => {
    const w = await world(), first = await w.start();
    w.advance(600_000);
    expect(await w.controller.status(first.operationId, w.session)).toMatchObject({ reason: "expired", issued: false, outcomeKnown: true });
    const abandoned = readLocalJoin(w.directory, first.operationId);
    if (restart) w.controller.close();
    const controller = restart ? new CompanyJoinController(w.options) : w.controller;
    const other = { ...w.session, ownerKey: {}, sessionId: "c".repeat(64) };
    const next = await controller.start({ address: w.metadata.hub.webOrigin, label: "Retry Fleet", fleetOrigin: "http://127.0.0.1:4444" }, { ...w.authority, session: other });
    expect(next).toMatchObject({ state: "awaiting-sign-in", issued: false }); expect(next.operationId).not.toBe(first.operationId);
    expect(currentLocalJoinId(w.directory)).toBe(next.operationId);
    expect(readLocalJoin(w.directory, first.operationId)).toEqual(abandoned);
    await expect(controller.resume(first.operationId, w.authority)).rejects.toThrow();
    expect(() => controller.bridge(first.operationId, w.session)).toThrow();
    w.ready(); expect(await controller.status(next.operationId, other)).toMatchObject({ state: "saved" });
    expect(w.calls.filter(c => c === "push")).toHaveLength(2); expect(w.calls.filter(c => c === "redeem")).toHaveLength(1);
    expect(w.activate).toHaveBeenCalledOnce(); controller.close();
  });
  it("an expired pending journal also permits Start before any timer has recorded the expiry", async () => {
    const w = await world(), first = await w.start(); w.advance(600_000);
    expect(readLocalJoin(w.directory, first.operationId).stage).toBe("pending");
    expect(await w.start()).toMatchObject({ state: "awaiting-sign-in" }); expect(w.calls).toEqual(["push", "push"]);
  });
  it("the original session sees an expired never-issued operation as ended, so the existing Start form is reachable", async () => {
    const w = await world(), first = await w.start(); w.advance(600_000);
    expect(w.controller.current(w.session)).toMatchObject({ operationId: first.operationId, state: "ended", reason: "expired", issued: false, outcomeKnown: true });
    expect(await w.controller.status(first.operationId, w.session)).toMatchObject({ state: "ended", reason: "expired" });
  });
  it("a live in-flight Start still blocks another session before and after its Hub push settles", async () => {
    const w = await world(); let release!: () => void, entered!: () => void;
    const held = new Promise<void>(r => { release = r; }), seen = new Promise<void>(r => { entered = r; });
    const original = w.client.command.getMockImplementation()!;
    w.client.command.mockImplementation(async (...args: any[]) => { if (args[1] === "push") { entered(); await held; } return (original as any)(...args); });
    const first = w.start(); await seen;
    const other = { ...w.authority, session: { ...w.session, ownerKey: {}, sessionId: "c".repeat(64) } };
    const attempt = () => w.controller.start({ address: w.metadata.hub.webOrigin, label: "Other Fleet", fleetOrigin: "http://127.0.0.1:4444" }, other);
    try { await expect(attempt()).rejects.toThrow(); } finally { release(); }
    const pending = await first; await expect(attempt()).rejects.toThrow();
    expect(w.calls).toEqual(["push"]); expect(currentLocalJoinId(w.directory)).toBe(pending.operationId);
  });
  it("expiry never clears an unknown issuance result after a lost credential reply", async () => {
    const w = await world(), first = await w.start(); w.ready();
    const original = w.client.command.getMockImplementation()!;
    w.client.command.mockImplementation(async (...args: any[]) => { const result = await (original as any)(...args); if (args[1] === "redeem") throw Error("lost issued reply"); return result; });
    expect(await w.controller.status(first.operationId, w.session)).toMatchObject({ state: "held", issued: false, outcomeKnown: false });
    w.advance(600_000);
    expect(w.controller.current(w.session)).toMatchObject({ state: "held", outcomeKnown: false });
    await expect(w.start()).rejects.toThrow(); w.controller.close();
    const restarted = new CompanyJoinController(w.options);
    await expect(restarted.start({ address: w.metadata.hub.webOrigin, label: "Retry Fleet", fleetOrigin: "http://127.0.0.1:4444" }, w.authority)).rejects.toThrow();
    expect(w.calls.filter(c => c === "push")).toHaveLength(1); expect(w.calls).not.toContain("ack"); expect(w.activate).not.toHaveBeenCalled(); restarted.close();
  });
  it("a late status from the expired operation cannot redeem or overwrite its fresh replacement", async () => {
    const w = await world(), first = await w.start(); let release!: () => void, entered!: () => void;
    const held = new Promise<void>(r => { release = r; }), seen = new Promise<void>(r => { entered = r; });
    const original = w.client.command.getMockImplementation()!;
    w.client.command.mockImplementation(async (...args: any[]) => { const result = await (original as any)(...args); if (args[1] === "status") { entered(); await held; return { ...result, state: "identity-approved" }; } return result; });
    const old = w.controller.status(first.operationId, w.session); await seen; w.advance(600_000);
    const next = await w.start(); release(); await old;
    expect(currentLocalJoinId(w.directory)).toBe(next.operationId);
    expect(w.controller.current(w.session)).toMatchObject({ operationId: next.operationId, state: "awaiting-sign-in" });
    expect(w.calls).not.toContain("redeem"); expect(w.calls).not.toContain("ack"); expect(w.activate).not.toHaveBeenCalled();
  });
  it("expiry does not relabel an issued active binding or an explicit unissued cancellation", async () => {
    const w = await world(), first = await w.start(); w.ready();
    expect(await w.controller.status(first.operationId, w.session)).toMatchObject({ state: "saved", issued: true });
    w.advance(600_000); expect(w.controller.current(w.session)).toMatchObject({ state: "saved", issued: true });
    await expect(w.start()).rejects.toThrow();
    const other = await world(), cancelled = await other.start();
    await other.controller.cancel(cancelled.operationId, other.session); other.advance(600_000);
    expect(other.controller.current(other.session)).toMatchObject({ state: "cancelled", reason: "cancelled", issued: false, outcomeKnown: true });
  });
  it("a shared Hub/Fleet hostname refuses before discovery, a TOFU pin or a remote push", async () => {
    const w = await world();
    await expect(w.controller.start({ address: w.metadata.hub.webOrigin, label: "My Fleet", fleetOrigin: "https://hub.example.test:7443" }, w.authority)).rejects.toThrow();
    expect(w.client.discover).not.toHaveBeenCalled(); expect(w.calls).toEqual([]);
    expect(existsSync(join(w.directory, "hub-member"))).toBe(false);
  });
  it("a pending journal from an older build cannot revive a same-hostname browser handoff", async () => {
    const w = await world(), pending = await w.start(), r = readLocalJoin(w.directory, pending.operationId);
    r.binding.fleetOrigin = "https://hub.example.test:7443";
    writeJoinPrivate(w.directory, `hub-member/company-joins/${r.operationId}.json`, JSON.stringify(r), () => true);
    expect(() => w.controller.bridge(r.operationId, w.session)).toThrow(); expect(w.calls).toEqual(["push"]);
  });
  it("an existing or unfinished legacy binding refuses before discovery or a new Hub reservation", async () => {
    const w = await world();
    createJoinPrivate(w.directory, "hub-member/state.json", JSON.stringify({ hubId: w.metadata.hub.hubId }));
    await expect(w.start()).rejects.toThrow();
    expect(w.client.discover).not.toHaveBeenCalled(); expect(w.calls).toEqual([]);
  });
  it("an orphan pending profile also refuses before any new reservation", async () => {
    const w = await world(); createJoinPrivate(w.directory, `hub-member/${w.metadata.hub.hubId}/pending.json`, "{}");
    await expect(w.start()).rejects.toThrow(); expect(w.client.discover).not.toHaveBeenCalled(); expect(w.calls).toEqual([]);
  });
  it("the existing exact disconnect and Start over allow a new explicitly requested join, never automatic reuse", async () => {
    const w = await world(), first = await w.start(); w.ready(); await w.controller.status(first.operationId, w.session);
    const pairing = createHubMemberPairingApi({ home: w.directory }), shown = pairing.view();
    expect(shown.state).toBe("paired"); if (shown.state !== "paired") throw Error("Expected settled binding");
    await pairing.disconnect({ hubId: shown.hub.hubId, binding: shown.binding });
    await expect(w.start()).rejects.toThrow(); pairing.cancel(); expect(currentBinding(w.directory)).toBeNull();
    const next = await w.start(); expect(next.operationId).not.toBe(first.operationId); w.ready();
    expect(await w.controller.status(next.operationId, w.session)).toMatchObject({ state: "saved" });
    expect(w.calls.filter(x => x === "push")).toHaveLength(2);
  });
  it("saves the exact profile and journal before proof ACK, then activates once without exposing any secret", async () => {
    const w = await world(), pending = await w.start(); w.ready();
    const view = await w.controller.status(pending.operationId, w.session);
    expect(view).toMatchObject({ state: "saved", link: "offline" }); expect(w.enabled()).toBe(true);
    expect(w.calls).toEqual(["push", "status", "redeem", "ack"]); expect(w.activate).toHaveBeenCalledOnce();
    expect(currentBinding(w.directory)).toEqual({ hubId: w.metadata.hub.hubId });
    const journal = readLocalJoin(w.directory, pending.operationId); expect(journal.stage).toBe("active");
    expect(JSON.stringify(view)).not.toMatch(/credential|privateKey|verifier|stateHash|BEGIN PRIVATE/);
    expect(await w.controller.status(pending.operationId, w.session)).toMatchObject({ state: "saved" }); expect(w.activate).toHaveBeenCalledOnce();
  });
  it("UI status reads share the bounded backend polling window instead of multiplying directory/status work", async () => {
    const w = await world(), pending = await w.start(); await w.controller.status(pending.operationId, w.session); w.ready();
    await w.controller.status(pending.operationId, w.session); await w.controller.status(pending.operationId, w.session);
    expect(w.calls.filter(c => c === "status")).toHaveLength(1); expect(w.calls).not.toContain("redeem");
    w.advance(1751); expect(await w.controller.status(pending.operationId, w.session)).toMatchObject({ state: "saved" });
  });
  it.each(["requester", "confirmer", "binding"])("a changed %s fences the original operation before credential persistence", async kind => {
    const w = await world(), pending = await w.start(); w.ready();
    if (kind === "requester") w.lose(); else if (kind === "confirmer") w.deny(); else w.replace();
    await w.controller.status(pending.operationId, w.session).catch(() => null);
    expect(w.calls).not.toContain("redeem"); expect(w.calls).not.toContain("ack"); expect(currentBinding(w.directory)).toBeNull(); expect(w.activate).not.toHaveBeenCalled();
  });
  it("a different cookie session cannot read, bridge or cancel an owned operation", async () => {
    const w = await world(), pending = await w.start(), other = { ...w.session, ownerKey: {}, sessionId: "c".repeat(64) };
    await expect(w.controller.status(pending.operationId, other)).rejects.toThrow();
    expect(() => w.controller.bridge(pending.operationId, other)).toThrow();
    await expect(w.controller.cancel(pending.operationId, other)).rejects.toThrow(); expect(w.calls).not.toContain("cancel");
  });
  it("profile saved but membership/journal failure remains held and unconnectable; exact recovery never enrolls twice", async () => {
    const w = await world(), pending = await w.start(); w.ready(); w.diskFailure(true);
    expect(await w.controller.status(pending.operationId, w.session)).toMatchObject({ state: "held" });
    expect(currentBinding(w.directory)).toBeNull(); expect(w.calls).not.toContain("ack"); expect(w.activate).not.toHaveBeenCalled();
    w.diskFailure(false); await w.controller.resume(pending.operationId, w.authority);
    expect(await w.controller.status(pending.operationId, w.session)).toMatchObject({ state: "saved" });
    expect(w.calls.filter(x => x === "push")).toHaveLength(1); expect(w.calls.filter(x => x === "redeem")).toHaveLength(2);
  });
  it("cancel wins while an issued credential response is held and never ACKs or activates a late result", async () => {
    const w = await world(), pending = await w.start(); w.ready();
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(r => { release = r; }), seen = new Promise<void>(r => { entered = r; });
    const original = w.client.command.getMockImplementation()!;
    w.client.command.mockImplementation(async (...args: any[]) => { const result = await (original as any)(...args); if (args[1] === "redeem") { entered(); await held; } return result; });
    const poll = w.controller.status(pending.operationId, w.session); await seen;
    await w.controller.cancel(pending.operationId, w.session); release(); await poll;
    expect(w.calls).not.toContain("ack"); expect(currentBinding(w.directory)).toBeNull(); expect(w.activate).not.toHaveBeenCalled();
  });
  it("a restarted controller reopens only the same host-owned operation and key; no fresh enrollment", async () => {
    const w = await world(), pending = await w.start(); w.ready(); w.controller.close();
    const next = new CompanyJoinController(w.options);
    expect(await next.status(pending.operationId, { ...w.session, ownerKey: {} })).toMatchObject({ state: "saved" });
    expect(w.calls.filter(x => x === "push")).toHaveLength(1);
  });
  it.each(["marker", "profile", "membership", "ack"])("recovers the exact owned %s crash window without another enrollment", async phase => {
    const w = await world(), pending = await w.start(); w.ready();
    const original = w.client.command.getMockImplementation()!, enable = w.options.enableMembership;
    if (phase === "marker" || phase === "profile") {
      const save = HubMemberProfileStore.prototype.saveProfile;
      vi.spyOn(HubMemberProfileStore.prototype, "saveProfile").mockImplementation(function (this: HubMemberProfileStore, ...args) {
        if (phase === "profile") save.apply(this, args);
        w.controller.close(); throw Error("crash after " + phase);
      });
    } else if (phase === "membership") {
      const enable = w.options.enableMembership;
      w.options.enableMembership = (current, _accept) => enable(current, () => { w.controller.close(); throw Error("crash after membership rename"); });
    } else w.client.command.mockImplementation(async (...args: any[]) => {
      const result = await (original as any)(...args); if (args[1] === "ack") { w.controller.close(); throw Error("lost ACK response and restart"); } return result;
    });
    await w.controller.status(pending.operationId, w.session);
    expect(currentBinding(w.directory)).toBeNull(); expect(w.activate).not.toHaveBeenCalled();
    vi.restoreAllMocks(); w.client.command.mockImplementation(original);
    const next = new CompanyJoinController({ ...w.options, enableMembership: enable });
    expect(await next.status(pending.operationId, { ...w.session, ownerKey: {} })).toMatchObject({ state: "saved" });
    expect(w.calls.filter(x => x === "push")).toHaveLength(1); expect(w.activate).toHaveBeenCalledOnce();
    expect(currentBinding(w.directory)).toEqual({ hubId: w.metadata.hub.hubId }); expect(w.enabled()).toBe(true);
  });
  it("a nonhost restart read asks for fresh local confirmation without permanently revoking the same operation", async () => {
    const w = await world(); w.session.hostHere = false; const pending = await w.start(); w.ready(); w.controller.close();
    const next = new CompanyJoinController(w.options);
    expect(await next.status(pending.operationId, w.session)).toMatchObject({ state: "held", reason: "confirmation-required" });
    expect(w.calls).not.toContain("redeem");
    expect(await next.resume(pending.operationId, w.authority)).toMatchObject({ state: "saved" });
    expect(w.calls.filter(x => x === "push")).toHaveLength(1);
  });
  it("a lost issuance reply and lost cancellation retain an unknown outcome until the exact tombstone is read", async () => {
    const w = await world(), pending = await w.start(); w.ready();
    const original = w.client.command.getMockImplementation()!;
    w.client.command.mockImplementation(async (...args: any[]) => {
      if (args[1] === "cancel") throw Error("offline");
      const result = await (original as any)(...args); if (args[1] === "redeem") throw Error("response dropped after commit"); return result;
    });
    expect(await w.controller.status(pending.operationId, w.session)).toMatchObject({ state: "held", issued: false, outcomeKnown: false });
    expect(await w.controller.cancel(pending.operationId, w.session)).toMatchObject({ state: "cancelled", outcomeKnown: false });
    await expect(w.start()).rejects.toThrow();
    expect(await w.controller.status(pending.operationId, w.session)).toMatchObject({ state: "cancelled", issued: true, outcomeKnown: true });
    await expect(w.start()).rejects.toThrow(); expect(w.calls.filter(x => x === "push")).toHaveLength(1);
    expect(w.calls).not.toContain("ack"); expect(currentBinding(w.directory)).toBeNull();
  });
});

describe("M-2921 (Hub UX U1): an enrolment code, and what the connected card shows", () => {
  it("a code goes in the push (without its dash) only when the Hub takes one; otherwise refused before any pin or journal", async () => {
    const w = await world();
    const pushes: any[] = []; const original = w.client.command.getMockImplementation()!;
    w.client.command.mockImplementation(async (...args: any[]) => { if (args[1] === "push") pushes.push(args[2]); return (original as any)(...args); });
    const refuse = w.controller.start({ address: w.metadata.hub.webOrigin, label: "Coded", fleetOrigin: "http://127.0.0.1:4444", code: "ABCD-EF23" }, w.authority);
    await expect(refuse).rejects.toMatchObject({ code: "incompatible" });
    expect(existsSync(join(w.directory, "hub-member/company-trust"))).toBe(false);
    expect(currentLocalJoinId(w.directory)).toBeNull();
    w.metadata.features.push("enrolment-code-v1");
    await w.controller.start({ address: w.metadata.hub.webOrigin, label: "Coded", fleetOrigin: "http://127.0.0.1:4444", code: "ABCD-EF23" }, w.authority);
    expect(pushes.at(-1)).toMatchObject({ label: "Coded", code: "ABCDEF23" });
    w.controller.close();
  });
  it("B1 alphabet: Crockford base32 in any case, 0 and 1 allowed, I/L/O/U refused (no aliases); pushed as 8 uppercase characters", () => {
    for (const ok of ["ABCD-EF01", "abcdef01", "0000-1111", "VWXY-Z789"]) expect(ENROLMENT_CODE.test(ok)).toBe(true);
    for (const bad of ["ABCI-EF23", "ABCL-EF23", "ABCO-EF23", "ABCU-EF23", "ABCD-EF2", "ABCD--EF23", "ABCD EF23"]) expect(ENROLMENT_CODE.test(bad)).toBe(false);
    expect(normalEnrolmentCode("abcd-ef01")).toBe("ABCDEF01");
  });
  it("a code with a letter outside the alphabet is invalid; a code together with an invitation is invalid; neither leaves a pin or a journal", async () => {
    const w = await world(); w.metadata.features.push("enrolment-code-v1");
    await expect(w.controller.start({ address: w.metadata.hub.webOrigin, label: "Coded", fleetOrigin: "http://127.0.0.1:4444", code: "ABCO-EF23" }, w.authority)).rejects.toMatchObject({ code: "invalid" });
    const at = Date.now(), claims = { v: 2 as const, id: randomUUID(), hub: w.metadata.hub, owner: { realm: "corp", objectId: randomUUID() },
      approvedBy: { realm: "corp", objectId: randomUUID() }, nonce: "c".repeat(64), createdAt: at, expiresAt: at + 600_000 };
    const signed = signCompanyInvitation(claims, createPrivateKey(readFileSync(join(w.hubHome, "hub/keys/issuer-key.pem"))));
    const invited = `${w.metadata.hub.webOrigin}/join-info#invite=${signed}`;
    expect(parseCompanyAddress(invited).invitation).toBe(signed);                     // a real invitation: the refusal is the code's
    await expect(w.controller.start({ address: invited, label: "Coded", fleetOrigin: "http://127.0.0.1:4444", code: "ABCD-EF23" }, w.authority)).rejects.toMatchObject({ code: "invalid" });
    expect(existsSync(join(w.directory, "hub-member/company-trust"))).toBe(false);
    expect(currentLocalJoinId(w.directory)).toBeNull();
    w.controller.close();
  });
  it("redeem asks for the display fields; the card's record holds the label, the address, the Hub's name and the owner's label", async () => {
    const w = await world();
    const original = w.client.command.getMockImplementation()!;
    w.client.command.mockImplementation(async (...args: any[]) => {
      const result = await (original as any)(...args);
      return args[1] === "redeem" && args[5]?.display ? { ...result, hubName: "Acme Hub", ownerLabel: "王小明" } : result;
    });
    const first = await w.start(); w.ready();
    expect(await w.controller.status(first.operationId, w.session)).toMatchObject({ state: "saved", issued: true });
    expect((w.client.command.mock.calls as any[][]).find(c => c[1] === "redeem")?.[5]).toEqual({ display: true });
    expect(w.controller.display()).toEqual({ v: 1, webOrigin: w.metadata.hub.webOrigin, label: "My Fleet", hubName: "Acme Hub", ownerLabel: "王小明" });
    w.controller.close();
  });
  it("an older Hub (no display fields in its answer): the record keeps the label and the address, the rest null", async () => {
    const w = await world();
    const first = await w.start(); w.ready();
    await w.controller.status(first.operationId, w.session);
    expect(w.controller.display()).toEqual({ v: 1, webOrigin: w.metadata.hub.webOrigin, label: "My Fleet", hubName: null, ownerLabel: null });
    w.controller.close();
  });
});
