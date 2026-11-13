/** Actual private seal/files + SQLite/session/role decision; fictional directory, no mounted route. */
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { roleAuthorityWorld } from "./support/hub-role-authority-rig.js";
import { provisionHubIdentity } from "../src/hub/tls.js";
import { sealHubInitialization, verifyHubInitialization } from "../src/hub/initialization.js";
import { hubPlanDigest } from "../src/hub/init/plan-digest.js";
import { BIND_PASSWORD_REF, BIND_SECRET_REL } from "../src/hub/init/layout.js";
import { ensurePrivateDirectory } from "../src/hub/private-files.js";
import { atomicWriteFileSync } from "../src/atomic-write.js";
import { createHubRoleAuthorizationClock } from "../src/hub/roles/clock.js";
import { createHubManagementAuthority } from "../src/hub/roles/authority.js";
import { bindHubDirectoryAdministration, type HubDirectoryAdministration } from "../src/hub/roles/directory-authority.js";
import { createHubDirectorySettingsDecision, HUB_DIRECTORY_SETTINGS_MIGRATION, type HubDirectoryDecisionRequest } from "../src/hub/settings-directory-decision.js";
import { createHubSettingsWriter, readHubDirectorySettingsImage, type HubDirectorySettingsCandidate, type HubDirectorySettingsWriter, type HubSettingsWriterDeps } from "../src/hub/settings-commit.js";

type Actor = HubDirectoryDecisionRequest["actor"];
type AdmissionWriter = {
  prepare(candidate: HubDirectorySettingsCandidate, actor: Actor, current: () => boolean, administration?: HubDirectoryAdministration): ReturnType<HubDirectorySettingsWriter["prepare"]>;
  commit(ref: string, actor: Actor, current: () => boolean, rotation?: Parameters<HubDirectorySettingsWriter["commit"]>[3], deadline?: number,
    administration?: HubDirectoryAdministration): ReturnType<HubDirectorySettingsWriter["commit"]>;
};
const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
async function world() {
  const home = mkdtempSync(join(tmpdir(), "hub-role-directory-writer-")); homes.push(home); chmodSync(home, 0o700);
  const memberOrigin = "https://member.example.test", identity = await provisionHubIdentity({ home, memberOrigin });
  const w = await roleAuthorityWorld({ hubId: identity.hubId, cutover: true }); HUB_DIRECTORY_SETTINGS_MIGRATION.up(w.db);
  const decision = createHubDirectorySettingsDecision({ db: w.db, transport: w.store, hubId: w.hubId, roleProofs: true });
  const config = join(home, "hub/owned-config.json"), manifest = join(home, "hub/init-manifest.json");
  const hub = { enabled: true, hubId: w.hubId, name: "Owned fixture", memberOrigin, webOrigin: "https://hub.example.test",
    webListen: { host: "127.0.0.1", port: 8444 }, memberListen: { host: "127.0.0.1", port: 8443 },
    administrator: w.root, directory: { realm: "corp", profile: "ad" as const, url: "ldaps://old.example.test", baseDn: "DC=example,DC=test",
      bindDn: "CN=owned-service", bindPasswordRef: BIND_PASSWORD_REF }, retention: { contentDays: 30, eventDays: 90 }, coexistence: "dedicated" };
  ensurePrivateDirectory(home, "hub/secrets"); writeFileSync(join(home, BIND_SECRET_REL), "owned old bind", { mode: 0o600 });
  writeFileSync(config, JSON.stringify(hub), { mode: 0o600 });
  const planDigest = hubPlanDigest(hub), confirmationId = "c".repeat(32), committedAt = "2026-11-08T00:00:00.000Z";
  writeFileSync(manifest, JSON.stringify({ v: 1, hubId: w.hubId, planDigest, confirmationId, committedAt,
    signature: sealHubInitialization({ home, planDigest, confirmationId, committedAt }) }), { mode: 0o600 });
  const readHub = () => JSON.parse(readFileSync(config, "utf8")) as typeof hub;
  const clock = createHubRoleAuthorizationClock({ db: w.db, hubId: w.hubId, root: w.root, realm: "corp", generation: "g1", transport: w.store,
    current: w.options.current, now: w.options.now });
  const authority = createHubManagementAuthority({ ...w.options, assertAuthorizationTime: clock.assertAuthorizationTime,
    directoryDecision: { db: w.db, hubId: w.hubId, assertAuthorizationTime: clock.assertDirectoryDecision } });
  const found = await w.ctx.ctx.current(); if (found.kind !== "directory") throw Error("fixture actor");
  const actor = { kind: "hub-administrator" as const, person: found.person, sessionId: found.sessionId, requestId: w.ctx.ctx.requestId };
  const source = () => {
    const expected = decision.proofBasis()?.expected ?? decision.inspect();
    return { directory: w.directory, administrator: w.root, epoch: expected.directoryEpoch, decisionProof: decision.administrationProof,
      image: createHash("sha256").update(JSON.stringify([w.hubId, expected, readHubDirectorySettingsImage(home, readHub())])).digest("hex") };
  };
  const permit = await authority.require(w.ctx.ctx, "hub.admin"), administration = bindHubDirectoryAdministration(permit, actor, source());
  let stepHook: ((step: string) => void) | undefined;
  const provider = () => ({ decision, source: source() });
  const deps = { home, readHub, now: w.options.now, directoryDecision: () => decision, directoryAdministration: provider,
    saveHub(patches) { const next = readHub(); for (const p of patches) { if (p.remove) delete (next as Record<string, unknown>)[p.path[1]!]; else (next as Record<string, unknown>)[p.path[1]!] = p.value; }
      atomicWriteFileSync(config, JSON.stringify(next), { mode: 0o600 }); }, step: (name: string) => stepHook?.(name),
  } satisfies HubSettingsWriterDeps & { directoryAdministration: typeof provider };
  const candidate = () => ({ directory: { ...readHub().directory, baseDn: "OU=Next,DC=example,DC=test" }, changes: ["search" as const], recipients: [{ kind: "host" as const, sink: "owner" }] });
  const writer = (over: Partial<typeof deps> = {}) => createHubSettingsWriter({ ...deps, ...over });
  const admission = (value: ReturnType<typeof writer>) => value.directory! as AdmissionWriter;
  const save = (value = writer(), witness: HubDirectoryAdministration | undefined = administration, who: Actor = actor, current = () => true) => {
    const d = admission(value), draft = d.prepare(candidate(), who, current, witness); return d.commit(draft.ref, who, current, undefined, undefined, witness);
  };
  return { ...w, authority, clock, home, readHub, manifest: () => readFileSync(manifest, "utf8"), decision, source, permit, administration, actor, deps, candidate, writer, admission, save,
    step(fn?: (name: string) => void) { stepHook = fn; }, verifies: () => verifyHubInitialization({ home, hubId: w.hubId, memberOrigin, planDigest: hubPlanDigest(readHub()) }) };
}

describe("S129 sealed directory writer admission", () => {
  it("uses the actual auxiliary administrator witness without replacing the configured root", async () => {
    const w = await world(), old = w.readHub(); let result: ReturnType<typeof w.save> | undefined;
    expect(() => { result = w.save(); }).not.toThrow();
    expect(w.readHub()).toEqual({ ...old, directory: w.candidate().directory });
    expect(w.verifies().planDigest).toBe(hubPlanDigest(w.readHub()));
    expect(w.decision.operation(result!.receiptId).actor).toEqual(w.actor);
    expect(w.readHub().administrator).toEqual(w.root);
  });
  it("refuses an auxiliary admin with only a successful current callback", async () => {
    const w = await world(), d = w.admission(w.writer());
    expect(() => d.prepare(w.candidate(), w.actor, () => true)).toThrow();
    expect(w.decision.inspect().operationId).toBeNull();
  });
  it("retains the root and D3 writer contracts without composing role admission", async () => {
    for (const mode of ["root", "host"] as const) {
      const w = await world(), writer = w.writer({ directoryAdministration: undefined as never });
      const actor: Actor = mode === "root" ? { ...w.actor, person: w.root } : { kind: "host-owner", sessionId: "owned-host", requestId: randomUUID() };
      const d = w.admission(writer);
      expect(() => { const draft = d.prepare(w.candidate(), actor, () => true); d.commit(draft.ref, actor, () => true); }).not.toThrow();
      expect(w.verifies()).toBeDefined();
    }
  });
});
