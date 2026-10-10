import { describe, expect, it, vi } from "vitest";
import { settingsEffectAuthority, settingsSecretAuthority } from "../src/settings-authority.js";
import { prepareSettingsEffect } from "../src/settings-effect.js";
import { SettingsConfirmationStore } from "../src/settings-confirmation.js";
import type { FleetConfig } from "../src/types.js";

const scope = (connections: string[], primaryGeneral = false, unknown = false) => ({ connections, primaryGeneral, unknown });
function config(): FleetConfig {
  return { defaults: { backend: "codex" }, instances: {
    worker: { working_directory: "/fixture/old", channel_id: "b", topic_id: 10 },
  }, channels: ["a", "b"].map(id => ({ id, type: "telegram", mode: "topic", group_id: "-100" + id,
    bot_token_env: "FIXTURE_" + id, access: { mode: "locked", allowed_users: [id + "-F"] } })) } as unknown as FleetConfig;
}
function effect(change: (next: FleetConfig) => void) {
  const before = config(), after = structuredClone(before); change(after);
  return settingsEffectAuthority(before, after, {}, {});
}
describe("#1490 normalized Settings authority", () => {
  it("access and destination changes belong to their existing connection", () => {
    expect(effect(next => { next.channels![1]!.access!.allowed_users = ["changed"]; })).toEqual(scope(["b"]));
    expect(effect(next => { next.channels![0]!.group_id = "-100changed"; })).toEqual(scope(["a"]));
    expect(effect(next => { Reflect.deleteProperty(next.channels![1]!, "access"); })).toEqual(scope(["b"]));
  });
  it("all existing targets are collected, without making the delivery exclusion list authoritative", () => {
    expect(effect(next => { for (const ch of next.channels!) ch.group_id += "changed"; })).toEqual(scope(["a", "b"]));
    const cfg = config(), body = cfg.channels!.map(ch => ({ ...ch, access: { ...ch.access, allowed_users: ["new"] } }));
    const diff = prepareSettingsEffect("PUT", "/api/settings/fleet/channels", body, { config: cfg, classic: {} }).diff!;
    expect(diff.authority).toEqual(scope(["a", "b"]));
  });
  it("reorder is fleet-wide; removing a connection requires that target and the primary authority", () => {
    expect(effect(next => { next.channels!.reverse(); })).toEqual(scope([], true));
    expect(effect(next => { next.channels!.pop(); })).toEqual(scope(["b"], true));
  });
  it("new connections retain primary authority, including mixed existing/new effects", () => {
    const add = (next: FleetConfig) => { next.channels!.push({ ...next.channels![0]!, id: "new", bot_token_env: "FIXTURE_NEW" }); };
    expect(effect(add)).toEqual(scope([], true));
    expect(effect(next => { add(next); next.channels![1]!.group_id += "changed"; })).toEqual(scope(["b"], true));
  });
  it("instance destinations use both old and new owners, and directory changes use the actual target", () => {
    expect(effect(next => { next.instances.worker.channel_id = "a"; })).toEqual(scope(["b", "a"]));
    expect(effect(next => { next.instances.worker.working_directory = "/fixture/new"; })).toEqual(scope(["b"]));
    expect(effect(next => { next.instances.worker.channel_id = "missing"; })).toEqual(scope(["b"], false, true));
  });
  it("Classic row overrides use persisted adapter ownership; ambiguous legacy rows stay host-only", () => {
    const cfg = config(), before = { channels: { group: { adapterId: "b", admin_users: ["C"] } } };
    expect(settingsEffectAuthority(cfg, cfg, before, { channels: { group: { ...before.channels.group, admin_users: ["new-C"] } } })).toEqual(scope(["b"]));
    expect(settingsEffectAuthority(cfg, cfg, { channels: { group: { admin_users: ["C"] } } }, { channels: { group: { admin_users: ["new-C"] } } })).toEqual(scope([], false, true));
    cfg.channels!.pop();
    expect(settingsEffectAuthority(cfg, cfg, { channels: { group: { admin_users: ["C"] } } }, { channels: { group: { admin_users: ["new-C"] } } })).toEqual(scope(["a"]));
    expect(settingsEffectAuthority(cfg, cfg, { defaults: { admin_users: ["C"] } }, { defaults: { admin_users: ["new-C"] } })).toEqual(scope([], true));
  });
  it("duplicate IDs, unknown owners and platform replacement cannot authorize a chat comparison", () => {
    expect(effect(next => { next.channels![1]!.id = "a"; })).toMatchObject({ unknown: true });
    expect(effect(next => { next.channels![0]!.type = "discord"; })).toEqual(scope(["a"], false, true));
  });
  it("global permission changes retain primary General authority", () => {
    expect(effect(next => { next.defaults.skipPermissions = false; })).toEqual(scope([], true));
    expect(effect(next => { next.project_roots = ["/fixture/root"]; })).toEqual(scope([], true));
  });
  it("a secret's aliases all require F; provider changes also require primary General F", () => {
    const cfg = config(); cfg.channels![1]!.bot_token_env = cfg.channels![0]!.bot_token_env;
    expect(settingsSecretAuthority(cfg, "a", "FIXTURE_a")).toEqual(scope(["a", "b"]));
    expect(settingsSecretAuthority(cfg, undefined, "FIXTURE_a")).toEqual(scope(["a", "b"], true));
    expect(settingsSecretAuthority(cfg, undefined, "PROVIDER_FIXTURE")).toEqual(scope([], true));
    expect(settingsSecretAuthority(cfg, "missing", "FIXTURE_a")).toEqual(scope(["missing", "a", "b"], false, true));
  });
  it("verified secret/binding projections carry actual targets and do not expose their secret", () => {
    const cfg = config(), proof = { key: "FIXTURE_b", secret: "test-secret", remainingMs: 1000,
      binding: { group_id: "-100new" }, discard() {} };
    const secret = prepareSettingsEffect("POST", "/api/settings/connections/b/secret/apply", { verification_id: "verified" }, { config: cfg, classic: {}, proof: () => proof }).diff!;
    expect(secret.authority).toEqual(scope(["b"])); expect(JSON.stringify(secret)).not.toContain(proof.secret);
    const binding = prepareSettingsEffect("POST", "/api/settings/connections/b/binding/apply", { verification_id: "verified" }, { config: cfg, classic: {}, proof: () => proof }).diff!;
    expect(binding.authority).toEqual(scope(["b"]));
  });
  it("request body authority fields cannot replace the server-owned projection", () => {
    const cfg = config();
    expect(() => prepareSettingsEffect("PUT", "/api/settings/fleet/web", { public_link: { ttl_minutes: 60 },
      authority: { connections: ["b"], primaryGeneral: false, unknown: false } }, { config: cfg, classic: {} })).toThrow("unsupported_sensitive_effect");
  });
  it("Quickstart new-connection consent retains primary F and a rebound instance's old owner", () => {
    const cfg = config(), body = { platform: "telegram", token: "test-secret", token_env: "FIXTURE_NEW", channel_id: "new",
      backend: "codex", instance_name: "worker", working_directory: "/fixture/new", group_id: "-100123", admin_user_id: "42" };
    const connection = prepareSettingsEffect("POST", "/api/settings/quickstart/commit", { ...body, connection_only: true }, { config: cfg, classic: {} }).diff!;
    expect(connection.authority).toEqual(scope([], true));
    // #1519 P7: an existing agent is never overwritten — it is rebound to the new connection, with its old owner's consent.
    expect(() => prepareSettingsEffect("POST", "/api/settings/quickstart/commit", body, { config: cfg, classic: {} })).toThrow(expect.objectContaining({ status: 409 }));
    const rebound = prepareSettingsEffect("POST", "/api/settings/quickstart/commit", { ...body, existing_agent: true }, { config: cfg, classic: {} }).diff!;
    expect(rebound.authority).toEqual(scope(["b"], true));
    expect(rebound.summary.join("\n")).toContain("worker");
    expect(JSON.stringify(rebound)).not.toContain(body.token);
  });
  it("store scope and audit fields are isolated from caller mutations and never added to the browser view", () => {
    const audit = vi.fn(), store = new SettingsConfirmationStore({ audit });
    try {
      const authority = scope(["a"]), { view } = store.propose({ session: "browser", key: "key", bytes: 1, source: "web_session", section: "access",
        requestedBy: "browser", fingerprint: "effect", summary: ["redacted"], authority, current: () => true, unchanged: async () => true, apply: async () => "ok" });
      authority.connections.push("b"); (store.authorityOf(view.id)!.connections as string[]).push("b");
      audit.mock.calls[0][1].authority.connections.push("b");
      expect(store.authorityOf(view.id)).toEqual(scope(["a"]));
      expect(view).not.toHaveProperty("authority"); expect(store.get(view.id, "browser")).not.toHaveProperty("authority");
    } finally { store.close(); }
  });
  it("missing internal metadata stays unknown and host-only", () => {
    const store = new SettingsConfirmationStore({ audit: vi.fn() });
    try {
      const { view } = store.propose({ session: "browser", key: "key", bytes: 1, source: "web_session", section: "access", requestedBy: "browser",
        fingerprint: "effect", summary: ["redacted"], current: () => true, unchanged: async () => true, apply: async () => "ok" });
      expect(store.authorityOf(view.id)).toEqual(scope([], false, true));
      expect(view.confirmation.kind).toBe("host_cli");
    } finally { store.close(); }
  });
});
