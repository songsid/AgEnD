/**
 * M-2909 (the owner, 11-11): a ClassicBot room's AI account (`channels.<key>.backend_options.<cli>.credential_profile` in
 * classicBot.yaml, #1220) could only be changed by editing the file. Settings → the room → Runtime & model now has the
 * agents' AI account picker; its save goes through PATCH /api/settings/classic/channels/:key like the room's other fields:
 * - the yaml write changes only that room's backend_options lines — every other line, comments included, stays byte-identical;
 * - clearing it (back to the fleet default) removes the key; a signed-out profile is refused (409) and nothing is written;
 * - a malformed value is refused (400);
 * - it costs a restart of that room's agent (impact "instance"), and the restarted launch reads the new profile — the
 *   ClassicChannelManager the restart reloads resolves it, and its credential home is that profile's (CLAUDE_CONFIG_DIR).
 */
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleSettingsRequest, type SettingsApiContext } from "../src/settings-api.js";
import { ClassicChannelManager } from "../src/classic-channel-manager.js";
import { credentialProfileEnv } from "../src/backend/credential-profile.js";
import { buildSettingsImpactSchema } from "../src/instance-config-impact.js";
import { settingsChangeDiff } from "../src/settings-change.js";

function request(path: string, ctx: SettingsApiContext, method: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter() as EventEmitter & { method: string; destroy(): void };
    req.method = method; req.destroy = () => undefined;
    let status = 0;
    const res = { writeHead(code: number) { status = code; }, setHeader() {}, end(payload: string) { resolve({ status, body: JSON.parse(payload) as Record<string, unknown> }); } };
    try {
      expect(handleSettingsRequest(req as never, res as never, new URL(`http://localhost${path}`), ctx)).toBe(true);
      if (body !== undefined) queueMicrotask(() => { req.emit("data", Buffer.from(JSON.stringify(body))); req.emit("end"); });
    } catch (err) { reject(err); }
  });
}
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "agend-2909-")); dirs.push(dir);
  // Two Claude profiles: "work" signed in, "ghost" made but never signed in.
  const work = join(dir, "credential-profiles", "claude-code", "work"); mkdirSync(work, { recursive: true });
  writeFileSync(join(work, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "c".repeat(40), refreshToken: "d".repeat(40), expiresAt: Date.now() + 3_600_000 } }));
  writeFileSync(join(work, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "u-1" } }));
  mkdirSync(join(dir, "credential-profiles", "claude-code", "ghost"), { recursive: true });
  const restartClassicInstanceFromSettings = vi.fn(async () => undefined);
  const ctx = {
    fleetConfig: { defaults: {}, instances: {} }, configPath: join(dir, "fleet.yaml"), dataDir: dir,
    logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() }, getRawFleetConfig: () => ({}), saveFleetConfig: vi.fn(),
    lifecycle: { isPaused: vi.fn(() => false), pause: vi.fn(), wake: vi.fn() },
    isClassicInstance: vi.fn(() => true), restartClassicInstanceFromSettings,
  } as unknown as SettingsApiContext;
  return { dir, ctx, restartClassicInstanceFromSettings, path: join(dir, "classicBot.yaml") };
}
/** A hand-written classicBot.yaml: comments, quoting and a second room the save must leave exactly as they are. */
const HAND = `# ClassicBot rooms — edited by hand
defaults:
  backend: claude-code   # the rooms' CLI
channels:
  "123#discord":
    instanceName: classic-alpha-0001
    channelId: "123"
    adapterId: discord
    model: 'opus'        # kept as typed
    collab: true
  "456#discord":
    instanceName: classic-beta-0002
    channelId: "456"
    adapterId: discord
    backend_options:
      claude-code:
        credential_profile: work
`;
const KEY = encodeURIComponent("123#discord");
/** Lines of `after` that are not in `before` (in order), and whether `before` survives as an in-order subsequence. */
function linesAdded(before: string, after: string): { added: string[]; kept: boolean } {
  const b = before.split("\n"), a = after.split("\n"), added: string[] = [];
  let i = 0;
  for (const line of a) { if (i < b.length && line === b[i]) i++; else added.push(line); }
  return { added, kept: i === b.length };
}

describe("PATCH a room's AI account (backend_options.<cli>.credential_profile)", () => {
  it("saves it — only that room's backend_options lines are added; every other byte (comments, quoting, the other room) stays", async () => {
    const { ctx, path, restartClassicInstanceFromSettings } = setup();
    writeFileSync(path, HAND);
    const r = await request(`/api/settings/classic/channels/${KEY}`, ctx, "PATCH", { backend_options: { "claude-code": { credential_profile: "work" } } });
    expect(r.status).toBe(200);
    const after = readFileSync(path, "utf8");
    const { added, kept } = linesAdded(HAND, after);
    expect(kept).toBe(true);
    expect(added.filter(Boolean).map(l => l.trim())).toEqual(["backend_options:", "claude-code:", "credential_profile: work"]);
    expect((yaml.load(after) as any).channels["123#discord"].backend_options).toEqual({ "claude-code": { credential_profile: "work" } });
    expect(restartClassicInstanceFromSettings).toHaveBeenCalledWith("classic-alpha-0001", ["backend_options"]);
  });
  it("clears it (back to the fleet default): the key goes, nothing else changes", async () => {
    const { ctx, path } = setup();
    writeFileSync(path, HAND);
    const r = await request(`/api/settings/classic/channels/${encodeURIComponent("456#discord")}`, ctx, "PATCH", { backend_options: null });
    expect(r.status).toBe(200);
    const after = readFileSync(path, "utf8");
    expect(linesAdded(after, HAND).kept).toBe(true);                                       // after ⊂ before, in order: lines only removed
    expect(linesAdded(after, HAND).added.map(l => l.trim()).filter(Boolean)).toEqual(["backend_options:", "claude-code:", "credential_profile: work"]);
    expect((yaml.load(after) as any).channels["456#discord"].backend_options).toBeUndefined();
  });
  it("a signed-out profile is refused (409, with how to sign in) and the file is not touched", async () => {
    const { ctx, path, restartClassicInstanceFromSettings } = setup();
    writeFileSync(path, HAND);
    const r = await request(`/api/settings/classic/channels/${KEY}`, ctx, "PATCH", { backend_options: { "claude-code": { credential_profile: "ghost" } } });
    expect([r.status, r.body.error, r.body.profile]).toEqual([409, "credential_profile_signed_out", "ghost"]);
    expect(readFileSync(path, "utf8")).toBe(HAND);
    expect(restartClassicInstanceFromSettings).not.toHaveBeenCalled();
  });
  it("a malformed value is refused (400)", async () => {
    const { ctx, path } = setup();
    writeFileSync(path, HAND);
    for (const bad of [{ "claude-code": { credential_profile: 5 } }, { "claude-code": { credential_profile: "../x" } }, { "claude-code": "work" }, ["work"]]) {
      expect((await request(`/api/settings/classic/channels/${KEY}`, ctx, "PATCH", { backend_options: bad })).status).toBe(400);
    }
    expect(readFileSync(path, "utf8")).toBe(HAND);
  });
  it("costs a restart of that room's agent, and the restarted launch reads the new profile (its CLAUDE_CONFIG_DIR)", async () => {
    expect(buildSettingsImpactSchema().impacts["classic.backend_options"]).toBe("instance");
    const { dir, ctx, path } = setup();
    writeFileSync(path, HAND);
    await request(`/api/settings/classic/channels/${KEY}`, ctx, "PATCH", { backend_options: { "claude-code": { credential_profile: "work" } } });
    const logger = { info() {}, warn() {}, debug() {}, error() {}, child() { return logger; } } as never;
    const manager = new ClassicChannelManager(dir, logger);
    manager.reloadFromDisk();
    const profile = manager.getCredentialProfileByInstance("classic-alpha-0001", { backend: "claude-code" });
    expect(profile).toMatchObject({ state: "profile", name: "work" });
    expect(credentialProfileEnv(dir, "claude-code", "work")).toEqual({ CLAUDE_CONFIG_DIR: join(dir, "credential-profiles", "claude-code", "work") });
  });
});

describe("a room's account is chosen like an agent's (#3335 / 721ca0c3): Save is the person's action, no extra confirmation", () => {
  const diff = (before: unknown, after: unknown) => settingsChangeDiff(before, after, { operation: "account-boundary" });
  const room = (options: unknown) => ({ classic: { channels: { "123#discord": { instanceName: "classic-a", backend_options: options } } } });
  it("a room's profile name can change or be cleared — the same narrow leaf as an agent's", () => {
    for (const cli of ["claude-code", "codex", "kiro-cli"]) for (const from of [undefined, "old-work", null]) for (const to of ["personal", undefined, null]) {
      expect(diff(room({ [cli]: { credential_profile: from } }), room({ [cli]: { credential_profile: to } }))).toBeNull();
    }
  });
  it("still not immediate: a bad name, a CLI without accounts, a sibling secret or permission, or the leaf anywhere else under classic", () => {
    for (const options of [{ "claude-code": { credential_profile: "../outside" } }, { other: { credential_profile: "personal" } }, { "claude-code": { credential_profile: "personal", permissions: "full" } }]) {
      expect(() => diff(room({}), room(options))).toThrow();
    }
    expect(diff(room({}), room({ "claude-code": { credential_profile: "personal", api_key: "SECRET-CANARY" } }))).not.toBeNull();
    expect(() => diff({ classic: { defaults: {} } }, { classic: { defaults: { backend_options: { "claude-code": { credential_profile: "personal" } } } } })).toThrow();
  });
});
