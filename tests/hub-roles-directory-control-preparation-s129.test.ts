/** Actual canonical role/session preparation; inert candidate directory and writer effects. */
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { roleAuthorityWorld } from "./support/hub-role-authority-rig.js";
import { createHubDirectorySettingsDecision, HUB_DIRECTORY_SETTINGS_MIGRATION } from "../src/hub/settings-directory-decision.js";
import { createHubRoleAuthorizationClock } from "../src/hub/roles/clock.js";
import { createHubManagementAuthority } from "../src/hub/roles/authority.js";
import { assertHubDirectoryAdministration, bindHubDirectoryAdministration, bindHubDirectoryPreparation } from "../src/hub/roles/directory-authority.js";
import { createHubDirectorySettingsControl } from "../src/hub/settings-directory-control.js";
import { createHubDirectorySettingsProof, type HubDirectoryProofContext, type HubDirectoryProofSource } from "../src/hub/settings-directory-proof.js";
import type { HubDirectorySessionProof } from "../src/hub/session-directory-transition.js";
import type { HubDirectorySettingsWriter } from "../src/hub/settings-commit.js";
import type { HubMountedDirectory } from "../src/hub/settings-directory-runtime.js";
import type { HubDirectory } from "../src/hub/directory/types.js";
import { BIND_PASSWORD_REF } from "../src/hub/init/layout.js";

async function world(mode: "preparation" | "witness" | "root" | "host" = "preparation") {
  const w = await roleAuthorityWorld({ cutover: true });
  HUB_DIRECTORY_SETTINGS_MIGRATION.up(w.db);
  const decision = createHubDirectorySettingsDecision({ db: w.db, hubId: w.hubId, transport: w.store, roleProofs: true });
  const clock = createHubRoleAuthorizationClock({ db: w.db, hubId: w.hubId, root: w.root, realm: "corp", generation: "g1", transport: w.store,
    current: w.options.current, now: w.options.now });
  const authority = createHubManagementAuthority({ ...w.options, assertAuthorizationTime: clock.assertAuthorizationTime,
    directoryDecision: { db: w.db, hubId: w.hubId, assertAuthorizationTime: clock.assertDirectoryDecision } });
  w.core.deps.management = authority;
  const selected = mode === "root" || mode === "host" ? await w.browser(w.root) : w.ctx;
  const found = await selected.ctx.current(); if (found.kind !== "directory") throw Error("owned directory session");
  const actor = { kind: "hub-administrator" as const, person: found.person, sessionId: found.sessionId, requestId: selected.ctx.requestId };
  const source: HubDirectoryProofSource = { directory: w.directory, administrator: w.root, epoch: 0, image: "a".repeat(64),
    decisionProof: decision.administrationProof, current: w.options.current, bindPassword: "synthetic-service",
    groups: [], config: { realm: "corp", profile: "ad", url: "ldaps://old.example.test", baseDn: "DC=example,DC=test", bindDn: "CN=Service", bindPasswordRef: BIND_PASSWORD_REF } };
  const preparation = mode === "preparation" ? await w.core.directoryPreparation(selected.ctx) : undefined;
  const permit = mode === "witness" ? await authority.require(selected.ctx, "hub.admin") : undefined;
  const context: HubDirectoryProofContext = mode === "host"
    ? { actor: { kind: "host-owner", sessionId: "owned-host", requestId: randomUUID() }, current: w.options.current }
    : { actor, current: () => w.options.current() && selected.ctx.isIdentityCurrent!(actor.person, actor.sessionId),
      ...(preparation ? { preparation: bindHubDirectoryPreparation(preparation, actor, source) } : {}),
      ...(permit ? { administration: bindHubDirectoryAdministration(permit, actor, source) } : {}) };
  const recent = vi.fn((who: typeof actor, proof?: HubDirectorySessionProof) => w.sessions.recentAuthentication(who, proof));
  const candidate: HubDirectory = { realm: "corp", async signIn() { throw Error("personal credentials reached candidate"); },
    checkEligibility: vi.fn(async person => ({ eligible: true as const, person: w.person(person) })), close: vi.fn(async () => {}) };
  const prepare = vi.fn<HubDirectorySettingsWriter["prepare"]>((_candidate, who, current, witness) => {
    expect(current()).toBe(true); if (witness) assertHubDirectoryAdministration(witness, who, source);
    return { ref: "inert-writer", expiresAt: 300100 };
  });
  const commit = vi.fn<HubDirectorySettingsWriter["commit"]>((_ref, who, current, _rotation, _deadline, witness) => {
    expect(current()).toBe(true); if (witness) assertHubDirectoryAdministration(witness, who, source);
    return { receiptId: randomUUID(), directoryEpoch: 1 };
  });
  const writer = { prepare, commit, compensate(): never { throw Error("unmounted compensation"); } };
  const sessions = { recentAuthentication: recent, prepareDirectoryRotation: w.sessions.prepareDirectoryRotation.bind(w.sessions),
    completeDirectoryRotation: w.sessions.completeDirectoryRotation.bind(w.sessions) };
  const mounted: HubMountedDirectory = { decision, current: w.options.current, source: () => source, sessions: () => sessions,
    withDirectoryRead: (person, work) => w.pool.withDirectoryRead(person, work) };
  const deps = { source: () => source, writer: () => writer, withDirectoryRead: mounted.withDirectoryRead,
    recentAuthentication: recent, now: w.options.now, createDirectory: () => candidate, probeTls: async () => "A".repeat(64) };
  const engine = createHubDirectorySettingsProof(deps);
  const control = createHubDirectorySettingsControl({ hubId: w.hubId, mounted: () => mounted, writer: () => writer,
    withDecision: async work => work(decision), remount: async () => {}, current: w.options.current,
    now: w.options.now, createDirectory: deps.createDirectory, probeTls: deps.probeTls });
  const input = () => ({ directory: { ...source.config, baseDn: "OU=Next,DC=example,DC=test" }, changes: ["search" as const],
    recipients: [{ kind: "host" as const, sink: "owner" }] });
  return { ...w, decision, actor, source, selected, context, preparation, recent, candidate, prepare, commit, control, engine, input,
    async finish() { engine.close(); await control.close(); } };
}

describe("S129 preparation-aware directory controller", () => {
  it("reads the auxiliary preparation's actual recent sign-in through the controller", async () => {
    const w = await world();
    try {
      expect(() => w.control.read(w.context)).not.toThrow();
      expect(w.control.read(w.context).reauthentication).toBe("recent");
    } finally { await w.finish(); }
  });
  it("keeps the effect witness when the controller asks its actual session adapter", async () => {
    const w = await world("witness");
    try { expect(w.control.read(w.context).reauthentication).toBe("recent"); }
    finally { await w.finish(); }
  });
  it("uses the recent auxiliary sign-in for a preparation without asking for another password", async () => {
    const w = await world();
    try {
      const draft = await w.engine.prepare(w.input(), w.context);
      await expect(w.engine.apply(draft.ref, {}, w.context)).resolves.toMatchObject({ directoryEpoch: 1 });
      expect(w.commit).toHaveBeenCalledOnce();
    } finally { await w.finish(); }
  });
  it.each(["root", "host"] as const)("retains the bare %s read contract", async mode => {
    const w = await world(mode);
    try { expect(w.control.read(w.context).reauthentication).toBe(mode === "host" ? "host" : "recent"); }
    finally { await w.finish(); }
  });
});
