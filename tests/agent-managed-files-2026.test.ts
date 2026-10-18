/** Private filesystem only: no real fleet, sessions, tokens or user configuration. */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readAgentFile, writeAgentFile } from "../src/agent-file-read.js";
import { readAgentEffect } from "../src/web-effect-upload.js";
import { writeModFile, writePreview } from "../src/web-asset-parts.js";
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture(name = "general", part = name) {
  const root = mkdtempSync(join(tmpdir(), "managed-files-2026-")); roots.push(root);
  const stateDir = join(root, "state"), workspace = join(stateDir, part);
  mkdirSync(workspace, { recursive: true });
  const save = (file: string, bytes = "asset") => { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, bytes); return file; };
  const config = (rows: Record<string, unknown> = { [name]: { working_directory: workspace } }) => save(join(stateDir, "fleet.yaml"), JSON.stringify({ instances: rows }));
  config();
  const effect = (dir: string) => {
    save(join(dir, "effect.json"), JSON.stringify({ v: 1, runtime: "canvas-worker-v1", worker: "worker.js", name: "test", title: "Test", regions: ["chat"], layer: "behind", wants: [] }));
    save(join(dir, "worker.js"), "agend.ready()"); return dir;
  };
  const opts = { stateDir, workspace, instance: name };
  const read = (file: string, extra = {}) => readAgentFile(file, { ...opts, maxBytes: 4096, ...extra });
  return { root, stateDir, workspace, name, save, config, effect, opts, read };
}
const sensitive = [".env", ".env.local", "web-chat.json", "web-files/upload.png", "fleet.yaml", "classicBot.yaml", "web-sessions.json", "web-devices.json", "web-prefs.json", "web-effects.json", "web-mods.json", "web-themes.json", "web-effect-profiles.json", "kiro-engine-ledger.json", "cache-codex-rollouts.json", "settings-apply-jobs.json", "cancel-buttons.json", "forged-envelope-reports.json", "upgrade-notices.json", "fleet.lock", "fleet.pid", "fleet.log", "daemon.log", "restart-audit.log", "tunnel.lease", "service-plan.json", "update-in-progress.json", "self-restart.json", "setup-complete.json", ".unknown-vendor/auth", "CLAUDE.md", "AGENTS.md", "mcp-config.json", "claude-settings.json", "credentials.json", "fleet.db", "fleet.db.backup", "web-sessions.json.tmp", "opencode.json.bak", "state.sqlite", "data.sqlite3-wal", "data.db-shm", "instances/a/x", "credential-profiles/a/x", "inbox/upload.png", "chat-logs/day.log", "cx/a/auth.json", "kiro-v3/data/x", "cli-env/x", "access/token", "web-sessions/x", "sessions/a.jsonl", "projects/a.jsonl", "session-env/x", "file-history/x", "shell-snapshots/x", "backups/x", "todos/x", "statsig/x", "ide/x", ".claude/settings.local.json", ".agents/skills/a", ".kiro/agents/a.json", ".grok/config.toml", ".codex/auth.json", ".muse/config", ".git/config", ".credentials.json", ".claude.json", ".mcp.json", "opencode.json", "opencode.jsonc", "config.toml", "settings.json", "settings.local.json", "auth.json", "history.jsonl", "agent.token", "session-id", "session-id.backend", "private.pem", "private.key", "private.pem.bak", "web.token.bak", "view.token", ".agend/private.json"];
describe("managed in-state appearance files", () => {
  it.each(["general", "general-telegram", "general-discord", "configured-worker"])("%s uses only its staged files and effect packages", async name => {
    const f = fixture(name);
    for (const part of ["web-assets/banner.png", "web-effects/banner.png"]) {
      const file = f.save(join(f.workspace, part));
      for (const path of [file, part]) expect(await f.read(path)).toMatchObject({ ok: true, bytes: Buffer.from("asset") });
    }
    expect(await readAgentEffect(f.effect(join(f.workspace, "web-effects/demo")), f.opts)).toMatchObject({ ok: true });
    expect(await readAgentEffect("web-effects/demo", f.opts)).toMatchObject({ ok: true });
    f.save(join(f.workspace, "root.png")); f.effect(join(f.workspace, "effect"));
    expect(await f.read("root.png")).toMatchObject({ ok: false });
    expect(await readAgentEffect("effect", f.opts)).toMatchObject({ ok: false });
  });
  it("a configured project inside its own workspace has ordinary access without granting sibling files", async () => {
    const f = fixture("worker", "workspaces/worker/project");
    f.save(join(f.workspace, "web-assets/banner.png"));
    expect(await f.read("web-assets/banner.png")).toMatchObject({ ok: true });
    f.save(join(f.workspace, "ordinary.png")); expect(await f.read("ordinary.png")).toMatchObject({ ok: true });
    f.save(join(f.stateDir, "workspaces/worker/sibling.png"));
    expect(await f.read("../sibling.png")).toMatchObject({ ok: false });
  });
  it("a sole caller inherits its managed cwd from fleet defaults, for CLI and daemon context", async () => {
    const f = fixture(); f.save(join(f.workspace, "web-assets/banner.png"));
    f.effect(join(f.workspace, "web-effects/demo"));
    f.save(join(f.stateDir, "fleet.yaml"), JSON.stringify({ defaults: { working_directory: f.workspace }, instances: { general: {} } }));
    for (const extra of [{}, { configuredWorkspace: f.workspace }]) {
      expect(await f.read("web-assets/banner.png", extra)).toMatchObject({ ok: true });
      expect(await readAgentEffect("web-effects/demo", { ...f.opts, ...extra })).toMatchObject({ ok: true });
      expect(await writeAgentFile(".agend/appearance", "dark.svg", Buffer.from("x"), { ...f.opts, ...extra })).toMatchObject({ ok: true });
    }
  });
  it.each(["same", "parent", "child"])("a peer inherits %s overlapping cwd from fleet defaults, refusing reads and writes", async mode => {
    const f = fixture(); f.save(join(f.workspace, "web-assets/banner.png"));
    const inherited = mode === "same" ? f.workspace : mode === "parent" ? f.stateDir : join(f.workspace, "web-assets");
    f.save(join(f.stateDir, "fleet.yaml"), JSON.stringify({ defaults: { working_directory: inherited }, instances: { general: { working_directory: f.workspace }, peer: {} } }));
    expect(await f.read("web-assets/banner.png")).toMatchObject({ ok: false });
    expect(await writeAgentFile(".agend/appearance", "dark.svg", Buffer.from("x"), f.opts)).toMatchObject({ ok: false });
    expect(existsSync(join(f.workspace, ".agend"))).toBe(false);
  });
  it("an explicit instance override wins over the inherited directory", async () => {
    const f = fixture(); f.save(join(f.workspace, "web-assets/banner.png"));
    const peer = join(f.root, "project"); mkdirSync(peer);
    f.save(join(f.stateDir, "fleet.yaml"), JSON.stringify({ defaults: { working_directory: f.workspace }, instances: { general: {}, peer: { working_directory: peer } } }));
    expect(await f.read("web-assets/banner.png")).toMatchObject({ ok: true });
    f.save(join(f.stateDir, "fleet.yaml"), JSON.stringify({ defaults: { working_directory: peer }, instances: { general: { working_directory: f.workspace }, peer: {} } }));
    expect(await f.read("web-assets/banner.png")).toMatchObject({ ok: true });
  });
  it("dynamic Classic does not inherit fleet working-directory defaults", async () => {
    const f = fixture("classic-x", "workspaces/classic-x"); f.save(join(f.workspace, "ordinary.png"));
    const general = join(f.stateDir, "general"); mkdirSync(general);
    f.save(join(f.stateDir, "fleet.yaml"), JSON.stringify({ defaults: { working_directory: general }, instances: { general: {} } }));
    expect(await f.read("ordinary.png", { configuredWorkspace: f.workspace })).toMatchObject({ ok: true });
  });
  it.each(["", null, false, 0])("falsy instance cwd %j overrides a default before conventional fallback", async value => {
    const f = fixture("worker", "workspaces/worker"); f.save(join(f.workspace, "ordinary.png"));
    f.save(join(f.stateDir, "fleet.yaml"), JSON.stringify({ defaults: { working_directory: join(f.stateDir, "general") }, instances: { worker: { working_directory: value } } }));
    expect(await f.read("ordinary.png")).toMatchObject({ ok: true });
  });
  it.each(sensitive)("refuses sensitive %s at root and inside staging and classic workspace", async part => {
    for (const classic of [false, true]) {
      const f = fixture("general", classic ? "workspaces/general" : "general");
      for (const prefix of ["", "web-assets/", "web-effects/"]) {
        const file = f.save(join(f.workspace, prefix + part));
        expect(await f.read(file), `${classic}:${prefix}${part}`).toMatchObject({ ok: false });
        expect(await writeAgentFile(prefix + part + "/out", "file.svg", Buffer.from("x"), f.opts)).toMatchObject({ ok: false });
      }
    }
  });
  it("keeps classic ordinary files, generated preview and mod export/readback", async () => {
    for (const part of ["general", "workspaces/general"]) {
      const f = fixture("general", part);
      const mod = await writeModFile([{ name: "demo-1.0.0.agendmod.json", data: Buffer.from("mod") }], f.opts);
      expect(mod).toHaveProperty("path"); if ("path" in mod) expect(await f.read(mod.path)).toMatchObject({ ok: true });
      const preview = await writePreview([{ name: "dark.svg", data: Buffer.from("<svg/>") }], f.opts);
      expect(preview).toHaveProperty("files"); if ("files" in preview) expect(readFileSync(preview.files[0]!.path, "utf8")).toBe("<svg/>");
      if (part.startsWith("workspaces/")) { f.save(join(f.workspace, "ordinary.png")); expect(await f.read("ordinary.png")).toMatchObject({ ok: true }); }
    }
  });
  it("denies another instance and outside cwd even when its files exist", async () => {
    const f = fixture(), other = f.save(join(f.stateDir, "general-telegram/web-assets/banner.png"));
    for (const file of [other, f.save(join(f.root, "tmp/image.png"))]) expect(await f.read(file)).toMatchObject({ ok: false });
    expect(await f.read(other, { workspace: join(f.stateDir, "general-telegram") })).toMatchObject({ ok: false });
    f.save(join(f.workspace, "web-assets/banner.png"));
    expect(await f.read("web-assets/banner.png", { instance: "other" })).toMatchObject({ ok: false });
  });
  it.each(["general", "web-assets", "web-effects", ".agend"])("symlink named %s never widens managed access", async part => {
    const f = fixture(), target = join(f.stateDir, "other");
    f.save(join(target, "banner.png")); f.save(join(target, "web-assets/banner.png")); f.effect(join(target, "effect"));
    const link = part === "general" ? f.workspace : join(f.workspace, part);
    if (part === "general") rmSync(link, { recursive: true });
    symlinkSync(target, link, "dir");
    const file = part === "general" ? "web-assets/banner.png" : part + "/banner.png";
    expect(await f.read(file)).toMatchObject({ ok: false });
    expect(await readAgentEffect(join(link, "effect"), f.opts)).toMatchObject({ ok: false });
    expect(await writeAgentFile(".agend/appearance", "dark.svg", Buffer.from("x"), f.opts)).toMatchObject(part === ".agend" || part === "general" ? { ok: false } : { ok: true });
    expect(existsSync(join(target, "appearance/dark.svg"))).toBe(false);
  });
  it("General symlink cannot grant an external directory", async () => {
    const f = fixture(), target = join(f.root, "outside"); f.save(join(target, "web-assets/banner.png"));
    rmSync(f.workspace, { recursive: true }); symlinkSync(target, f.workspace, "dir");
    expect(await f.read("web-assets/banner.png")).toMatchObject({ ok: false });
    expect(await readAgentEffect(f.effect(join(target, "web-effects/demo")), f.opts)).toMatchObject({ ok: false });
    expect(await writeAgentFile(".agend/appearance", "dark.svg", Buffer.from("x"), f.opts)).toMatchObject({ ok: false });
    expect(existsSync(join(target, ".agend"))).toBe(false);
  });
  it("a staging root cannot alias another staging root", async () => {
    const f = fixture(); f.save(join(f.workspace, "web-effects/banner.png"));
    symlinkSync(join(f.workspace, "web-effects"), join(f.workspace, "web-assets"), "dir");
    expect(await f.read("web-assets/banner.png")).toMatchObject({ ok: false });
    expect(await f.read("web-effects/banner.png")).toMatchObject({ ok: true });
  });
  it("rejects .env symlink, hardlink and a symlinked effect worker in staging", async () => {
    const f = fixture(), secret = f.save(join(f.stateDir, ".env"), "secret");
    mkdirSync(join(f.workspace, "web-assets"));
    symlinkSync(secret, join(f.workspace, "web-assets/link.png")); linkSync(secret, join(f.workspace, "web-assets/hard.png"));
    for (const name of ["link.png", "hard.png"]) expect(await f.read("web-assets/" + name)).toMatchObject({ ok: false });
    const dir = f.effect(join(f.workspace, "web-effects/demo")); rmSync(join(dir, "worker.js")); symlinkSync(secret, join(dir, "worker.js"));
    expect(await readAgentEffect(dir, f.opts)).toMatchObject({ ok: false });
  });
  it.each(["same", "ancestor", "descendant", "alias"])("refuses %s shared/overlapping configured directories", async mode => {
    const f = fixture(); f.save(join(f.workspace, "web-assets/banner.png"));
    let other = mode === "ancestor" ? f.stateDir : mode === "descendant" ? join(f.workspace, "web-assets") : f.workspace;
    if (mode === "alias") { other = join(f.root, "alias"); symlinkSync(f.workspace, other, "dir"); }
    f.config({ general: { working_directory: f.workspace }, other: { working_directory: other } });
    expect(await f.read("web-assets/banner.png")).toMatchObject({ ok: false });
    expect(await writeAgentFile("web-assets/output", "file.png", Buffer.from("x"), f.opts)).toMatchObject({ ok: false });
    expect(existsSync(join(f.workspace, "web-assets/output"))).toBe(false);
  });
  it.each(["", "workspaces", "instances/general", "credential-profiles/general", "cx/general", "kiro-v3/general", "inbox", "web-effects/general", "web-mods", "web-themes", "web-owner-css", "cards", "avatars", "cache", "web-files", "kiro-identity", "operator", "model-catalog", "profiles", "preview-tunnel", "bin", ".agend/appearance", ".vendor/data"])("configured cwd %s cannot turn protected/shared state into asset scope", async part => {
    const f = fixture("general", part); f.save(join(f.workspace, "web-assets/banner.png"));
    expect(await f.read("web-assets/banner.png")).toMatchObject({ ok: false });
  });
  it("canonical state alias works, but swapped General parent does not", async () => {
    const f = fixture(), alias = join(f.root, "state-alias"); symlinkSync(f.stateDir, alias, "dir");
    f.save(join(f.workspace, "web-assets/banner.png"));
    f.config({ general: { working_directory: join(alias, "general") } });
    expect(await f.read("web-assets/banner.png", { stateDir: alias, workspace: join(alias, "general") })).toMatchObject({ ok: true });
    const g = fixture("general", "custom/general"), target = join(g.root, "target"); g.save(join(target, "general/web-assets/banner.png"));
    rmSync(join(g.stateDir, "custom"), { recursive: true }); symlinkSync(target, join(g.stateDir, "custom"), "dir");
    expect(await g.read("web-assets/banner.png")).toMatchObject({ ok: false });
  });
  it.each(["", "{broken", "[]", "null", "instances: []", 'instances: { general: { working_directory: 3 } }'])("unreadable/unknown roster %s fails closed", async config => {
    const f = fixture(); f.save(join(f.workspace, "web-assets/banner.png")); f.save(join(f.stateDir, "fleet.yaml"), config);
    expect(await f.read("web-assets/banner.png")).toMatchObject({ ok: false });
  });
  it("daemon launch config mismatch refuses; shell cwd does not establish ownership", async () => {
    const f = fixture(); f.save(join(f.workspace, "web-assets/banner.png"));
    expect(await f.read("web-assets/banner.png", { configuredWorkspace: join(f.stateDir, "other") })).toMatchObject({ ok: false });
    rmSync(join(f.stateDir, "fleet.yaml"));
    expect(await f.read("web-assets/banner.png", { configuredWorkspace: f.workspace })).toMatchObject({ ok: false });
  });
  it("write rejection checks the final filename before creating directories", async () => {
    const f = fixture();
    expect(await writeAgentFile("web-assets/new", "auth.json", Buffer.from("secret"), f.opts)).toMatchObject({ ok: false });
    expect(existsSync(join(f.workspace, "web-assets"))).toBe(false);
  });
  it.each([["general", "general"], ["general-telegram", "general-telegram"], ["alpha", "workspaces/alpha-home"]])("daemon %s reads bytes from configured %s, never a tool-selected identity", async (name, part) => {
    const f = fixture(name, part); f.save(join(f.workspace, "web-assets/banner.png"));
    const { Daemon } = await import("../src/daemon.js");
    const { default: pino } = await import("pino");
    const { vi } = await import("vitest");
    vi.stubEnv("AGEND_HOME", f.stateDir);
    try {
      const daemon = new Daemon(name, { working_directory: f.workspace, log_level: "error", restart_policy: { max_retries: 1, backoff: "exponential", reset_after: 300 } } as never,
        join(f.stateDir, "instances", name), true, undefined, undefined, pino({ level: "silent" }) as never) as any;
      const broadcast = vi.fn(), send = vi.fn((_socket: unknown, _msg: unknown) => true); daemon.ipcServer = { broadcast, send };
      daemon.handleToolCall({ tool: "set_web_theme_asset", args: { slot: "banner", file: "web-assets/banner.png", instance: "other" }, requestId: 1 }, {});
      await vi.waitFor(() => expect(broadcast).toHaveBeenCalledOnce());
      const msg = broadcast.mock.calls[0]![0];
      expect(msg.meta.instance_name).toBe(name); expect(Buffer.from(msg.payload.data_b64, "base64").toString()).toBe("asset");
      f.save(join(f.workspace, ".env"), "secret");
      daemon.handleToolCall({ tool: "set_web_theme_asset", args: { slot: "banner", file: ".env" }, requestId: 2 }, {});
      await vi.waitFor(() => expect(send).toHaveBeenCalled()); expect(broadcast).toHaveBeenCalledOnce();
      expect(send.mock.calls.at(-1)![1]).toMatchObject({ requestId: 2, error: expect.stringContaining("state directory") });
      // A launch snapshot and the persisted roster must agree; a nested cwd is not independent ownership.
      const nested = join(f.workspace, "web-assets/nested"); f.save(join(nested, "web-assets/banner.png"));
      daemon.config.working_directory = nested;
      daemon.handleToolCall({ tool: "set_web_theme_asset", args: { slot: "banner", file: "web-assets/banner.png" }, requestId: 3 }, {});
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2)); expect(broadcast).toHaveBeenCalledOnce();
      expect(send.mock.calls.at(-1)![1]).toMatchObject({ requestId: 3, error: expect.stringContaining("state directory") });
    } finally { vi.unstubAllEnvs(); }
  });
  it.each(["a\\b", "a\u0001b"])("invalid caller %j cannot own an existing exact workspace", async name => {
    const f = fixture(name, "workspaces/" + name); f.save(join(f.workspace, "web-assets/banner.png"));
    f.effect(join(f.workspace, "web-effects/demo"));
    expect(await f.read("web-assets/banner.png")).toMatchObject({ ok: false });
    expect(await readAgentEffect("web-effects/demo", f.opts)).toMatchObject({ ok: false });
  });
  it("external projects retain ordinary reads despite malformed fleet config", async () => {
    const f = fixture(), project = join(f.root, "project"); f.save(join(project, "ordinary.png")); f.save(join(f.stateDir, "fleet.yaml"), "{broken");
    expect(await f.read("ordinary.png", { workspace: project })).toMatchObject({ ok: true });
    expect(await f.read(join(f.workspace, "web-assets/no.png"), { workspace: project })).toMatchObject({ ok: false });
  });
});
