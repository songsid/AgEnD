import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { Daemon } from "../src/daemon.js";
import { outboundHandlers, type OutboundContext } from "../src/outbound-handlers.js";
import { createTranscriptSource, kiroStoreDbPath } from "../src/transcript-sources.js";
import { credentialProfileLogin, credentialProfileStoreHome } from "../src/backend/credential-profile.js";

const dirs: string[] = [];
const envBackup = { ...process.env };

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agend-profile-session-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const key of ["AGEND_HOME", "XDG_DATA_HOME"]) {
    if (envBackup[key] === undefined) delete process.env[key];
    else process.env[key] = envBackup[key];
  }
  vi.restoreAllMocks();
});

/** A kiro store, optionally with a login in it. */
function makeStore(storeHome: string, opts: { login?: boolean } = {}): string {
  mkdirSync(storeHome, { recursive: true });
  const db = new Database(join(storeHome, "data.sqlite3"));
  db.exec("CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)");
  if (opts.login) {
    db.prepare("INSERT INTO auth_kv (key, value) VALUES (?, ?)").run(
      "kirocli:odic:token",
      JSON.stringify({ access_token: "token", expires_at: new Date(Date.now() + 3_600_000).toISOString() }),
    );
  }
  db.close();
  return storeHome;
}

function profileStore(dataDir: string, profile: string): string {
  return join(dataDir, "credential-profiles", "kiro-cli", profile, "kiro-cli");
}

// ── Refusing a switch that would park the agent on a login screen ────────────

describe("switching to a subscription nobody has logged into", () => {
  it("can tell a logged-in profile from one that only has a directory", () => {
    const dataDir = tempDir();
    makeStore(profileStore(dataDir, "work"), { login: true });
    makeStore(profileStore(dataDir, "empty"));

    expect(credentialProfileLogin(dataDir, "kiro-cli", "work")).toEqual({ state: "logged-in" });
    expect(credentialProfileLogin(dataDir, "kiro-cli", "empty").state).toBe("signed-out");
    // Never logged in at all: no directory, same answer.
    expect(credentialProfileLogin(dataDir, "kiro-cli", "absent").state).toBe("signed-out");
  });

  it("hands back the exact command, pointed at the profile home", () => {
    const dataDir = tempDir();
    const login = credentialProfileLogin(dataDir, "kiro-cli", "personal");

    expect(login).toMatchObject({ state: "signed-out" });
    const command = (login as { loginCommand: string }).loginCommand;
    // The variable kiro-cli itself reads, the profile home (not the store
    // inside it), and the subcommand — a paraphrase is how someone logs the
    // wrong profile in.
    expect(command).toContain("XDG_DATA_HOME=");
    expect(command).toContain(join(dataDir, "credential-profiles", "kiro-cli", "personal"));
    expect(command).toMatch(/kiro-cli login$/);
  });

  it("says nothing about a backend it cannot check", () => {
    // codex has no credential home yet, so there is no login to probe. An
    // unknown answer must not read as "signed out" and block an edit.
    expect(credentialProfileLogin(tempDir(), "codex", "work")).toEqual({ state: "unknown" });
  });
});

// ── The handler: the gate, the fresh start, the handover ────────────────────

interface Harness {
  ctx: OutboundContext;
  instance: Record<string, unknown>;
  dataDir: string;
  restartSingleInstance: ReturnType<typeof vi.fn>;
  saveFleetConfig: ReturnType<typeof vi.fn>;
  delivered: Array<Record<string, unknown>>;
  daemons: Map<string, { collectHandoverContext(): string }>;
}

function harness(instance: Record<string, unknown>, opts: { handover?: string } = {}): Harness {
  const dataDir = tempDir();
  const restartSingleInstance = vi.fn(async () => {});
  const saveFleetConfig = vi.fn();
  const delivered: Array<Record<string, unknown>> = [];
  const daemons = new Map<string, { collectHandoverContext(): string }>();
  if (opts.handover !== undefined) {
    daemons.set("worker", { collectHandoverContext: () => opts.handover! });
  }
  const daemonsRef = daemons;
  // A real restart stops the daemon and builds a new one, so the ring buffer
  // the handover comes from is gone by the time it resolves. Modelling that
  // here is what makes the collect-before-restart ordering testable at all:
  // with a mock that leaves the map alone, moving the collect after the restart
  // stays green.
  restartSingleInstance.mockImplementation(async () => { daemons.delete("worker"); });
  const ctx = {
    dataDir,
    fleetConfig: { defaults: {}, instances: { worker: instance } },
    classicChannels: { getAll: () => [] },
    saveFleetConfig,
    restartSingleInstance,
    lifecycle: { daemons, isPaused: () => false },
    instanceIpcClients: new Map([["worker", { send: (m: Record<string, unknown>) => { delivered.push(m); } }]]),
    getInstanceStatus: () => "running",
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as unknown as OutboundContext;
  return { ctx, instance, dataDir, restartSingleInstance, saveFleetConfig, delivered, daemons: daemonsRef };
}

async function update(h: Harness, config: unknown): Promise<{ result: Record<string, unknown> | null; error?: string }> {
  let result: Record<string, unknown> | null = null;
  let error: string | undefined;
  let settled: (() => void) | null = null;
  const done = new Promise<void>(resolve => { settled = resolve; });
  await outboundHandlers.get("update_instance_config")!(
    h.ctx,
    { name: "worker", config } as never,
    (r, e) => { result = r as Record<string, unknown>; error = e; settled?.(); },
    {} as never,
  );
  // The handover settles for 3s before the handler answers.
  await Promise.race([done, new Promise(r => setTimeout(r, 6_000))]);
  return { result, error };
}

describe("a profile switch is refused before it can strand the agent", () => {
  it("refuses a profile with no login and leaves the config exactly as it was", async () => {
    const h = harness({ working_directory: "/tmp/w", backend: "kiro-cli" });

    const { error } = await update(h, { backend_options: { "kiro-cli": { credential_profile: "personal" } } });

    expect(error).toContain("has no kiro-cli login yet");
    expect(error).toContain("XDG_DATA_HOME=");
    // Rolled back, never written, never restarted: the whole point is that the
    // agent keeps running on the subscription it is logged into.
    expect(h.instance.backend_options).toBeUndefined();
    expect(h.saveFleetConfig).not.toHaveBeenCalled();
    expect(h.restartSingleInstance).not.toHaveBeenCalled();
  });

  it("refuses it for a stopped agent too, rather than breaking its next start", async () => {
    const h = harness({ working_directory: "/tmp/w", backend: "kiro-cli" });
    (h.ctx as unknown as { getInstanceStatus: () => string }).getInstanceStatus = () => "stopped";

    const { error } = await update(h, { backend_options: { "kiro-cli": { credential_profile: "personal" } } });

    expect(error).toContain("has no kiro-cli login yet");
    expect(h.saveFleetConfig).not.toHaveBeenCalled();
  });

  it("allows the switch once that profile has been logged in", async () => {
    const h = harness({ working_directory: "/tmp/w", backend: "kiro-cli" });
    makeStore(profileStore(h.dataDir, "personal"), { login: true });

    const { result, error } = await update(h, { backend_options: { "kiro-cli": { credential_profile: "personal" } } });

    expect(error).toBeUndefined();
    expect(result).toMatchObject({ success: true, restarted: true });
    expect(h.instance.backend_options).toEqual({ "kiro-cli": { credential_profile: "personal" } });
  });

  it("never blocks the way back to the default login", async () => {
    // Undoing a bad switch must not need a login: the shared store is the
    // escape hatch, and refusing it would trap the agent on the broken profile.
    const h = harness({
      working_directory: "/tmp/w", backend: "kiro-cli",
      backend_options: { "kiro-cli": { credential_profile: "personal" } },
    });

    const { result, error } = await update(h, { backend_options: { "kiro-cli": { credential_profile: null } } });

    expect(error).toBeUndefined();
    expect(result).toMatchObject({ success: true, credential_profile_switched: true });
    // The namespace is dropped, so the instance is back on the shared login.
    expect(h.instance.backend_options).toEqual({});
  });

  it("does not block a backend whose login it cannot see", async () => {
    const h = harness({ working_directory: "/tmp/w", backend: "codex" });

    const { error } = await update(h, { backend_options: { codex: { credential_profile: "work" } } });

    expect(error).toBeUndefined();
    expect(h.saveFleetConfig).toHaveBeenCalled();
  });
});

describe("a switched agent starts a new session and is told why", () => {
  it("skips resume, because the new store has no conversation for this directory", async () => {
    const h = harness({ working_directory: "/tmp/w", backend: "kiro-cli" });
    makeStore(profileStore(h.dataDir, "personal"), { login: true });

    await update(h, { backend_options: { "kiro-cli": { credential_profile: "personal" } } });

    expect(h.restartSingleInstance).toHaveBeenCalledWith("worker", { freshStart: true });
  });

  it("resumes as usual when the subscription did not change", async () => {
    // A sibling option still restarts — the CLI reads it at launch — but the
    // conversation is in the same store, so throwing it away would be a loss.
    const h = harness({
      working_directory: "/tmp/w", backend: "kiro-cli",
      backend_options: { "kiro-cli": { credential_profile: "personal" } },
    }, { handover: "Recent user messages:\n- ship the release" });
    makeStore(profileStore(h.dataDir, "personal"), { login: true });

    const { result } = await update(h, { backend_options: { "kiro-cli": { kiro_future_option: "on" } } });

    expect(h.restartSingleInstance).toHaveBeenCalledWith("worker", undefined);
    expect(h.delivered).toEqual([]);
    expect(result).not.toHaveProperty("credential_profile_switched");
  });

  it("hands the work over, saying the conversation did not come with it", async () => {
    const context = "Recent user messages:\n- finish the migration";
    const h = harness({ working_directory: "/tmp/w", backend: "kiro-cli" }, { handover: context });
    makeStore(profileStore(h.dataDir, "personal"), { login: true });

    const { result } = await update(h, { backend_options: { "kiro-cli": { credential_profile: "personal" } } });

    expect(h.delivered).toHaveLength(1);
    const content = h.delivered[0]!.content as string;
    expect(content).toContain("[system:handover]");
    // Both ends named, and the loss stated rather than implied.
    expect(content).toContain("the default login");
    expect(content).toContain("personal");
    expect(content).toContain("did not carry over");
    // The intent itself, from the daemon's ring buffer.
    expect(content).toContain("finish the migration");
    expect(result).toMatchObject({ conversation_carried_over: false, handover_chars: context.length });
  }, 10_000);

  it("takes the context before the restart, while the daemon holding it exists", async () => {
    // The ring buffer lives in the daemon the restart is about to tear down.
    // Collecting after the restart would find nothing and hand the new session
    // an empty brief — silently, because everything else still succeeds.
    const context = "Recent user messages:\n- finish the migration";
    const h = harness({ working_directory: "/tmp/w", backend: "kiro-cli" }, { handover: context });
    makeStore(profileStore(h.dataDir, "personal"), { login: true });

    await update(h, { backend_options: { "kiro-cli": { credential_profile: "personal" } } });

    // The restart really did remove it, so the assertion above is not vacuous.
    expect(h.daemons.has("worker")).toBe(false);
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]!.content as string).toContain("finish the migration");
  }, 10_000);

  it("still completes the switch when there is nothing to hand over", async () => {
    const h = harness({ working_directory: "/tmp/w", backend: "kiro-cli" });
    makeStore(profileStore(h.dataDir, "personal"), { login: true });

    const { result } = await update(h, { backend_options: { "kiro-cli": { credential_profile: "personal" } } });

    expect(h.delivered).toEqual([]);
    expect(result).toMatchObject({ restarted: true, handover_chars: 0 });
  });
});

// ── Following the conversation into the profile's own store ─────────────────

describe("the transcript reader follows the profile", () => {
  /** A store with one conversation for this working directory. */
  function storeWithConversation(storeHome: string, cwd: string, toolName: string): string {
    mkdirSync(storeHome, { recursive: true });
    const db = new Database(join(storeHome, "data.sqlite3"));
    db.exec(`CREATE TABLE conversations_v2 (
      key TEXT NOT NULL, conversation_id TEXT NOT NULL, value TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (key, conversation_id)
    )`);
    db.prepare("INSERT INTO conversations_v2 VALUES (?, ?, ?, ?, ?)").run(
      cwd, `conv-${toolName}`, JSON.stringify({ history: [] }), Date.now() - 60_000, Date.now() - 10_000,
    );
    db.close();
    return storeHome;
  }

  function appendToolUse(storeHome: string, toolName: string): void {
    const db = new Database(join(storeHome, "data.sqlite3"));
    const entry = {
      user: { content: { ToolUseResults: { tool_use_results: [] } } },
      assistant: { ToolUse: { tool_uses: [{ id: "t1", name: toolName, args: {} }] } },
    };
    db.prepare("UPDATE conversations_v2 SET value = ?, updated_at = ? WHERE conversation_id = ?")
      .run(JSON.stringify({ history: [entry] }), Date.now(), `conv-${toolName}`);
    db.close();
  }

  it("reads the profile's store, not the shared one", async () => {
    const cwd = "/tmp/work-dir";
    const shared = storeWithConversation(join(tempDir(), "kiro-cli"), cwd, "shared_tool");
    process.env.XDG_DATA_HOME = join(shared, "..");
    const profile = storeWithConversation(join(tempDir(), "profile-store"), cwd, "profile_tool");
    const sharedBefore = statSync(join(shared, "data.sqlite3"));

    const source = createTranscriptSource("kiro-cli", cwd, profile)!;
    appendToolUse(profile, "profile_tool");
    const events = await source.poll();

    expect(events.toolUses.map(t => t.name)).toEqual(["profile_tool"]);
    // The shared login's conversation belongs to some other agent, and is only
    // ever read, never written.
    const sharedAfter = statSync(join(shared, "data.sqlite3"));
    expect([sharedAfter.mtimeMs, sharedAfter.size]).toEqual([sharedBefore.mtimeMs, sharedBefore.size]);
  });

  it("keeps reading the shared store when there is no profile", async () => {
    const cwd = "/tmp/work-dir";
    const shared = storeWithConversation(join(tempDir(), "kiro-cli"), cwd, "shared_tool");
    process.env.XDG_DATA_HOME = join(shared, "..");

    const source = createTranscriptSource("kiro-cli", cwd)!;
    appendToolUse(shared, "shared_tool");

    expect((await source.poll()).toolUses.map(t => t.name)).toEqual(["shared_tool"]);
  });

  it("puts the database where the backend keeps it", () => {
    process.env.XDG_DATA_HOME = "/xdg";

    expect(kiroStoreDbPath()).toBe("/xdg/kiro-cli/data.sqlite3");
    expect(kiroStoreDbPath("/profiles/work/kiro-cli")).toBe("/profiles/work/kiro-cli/data.sqlite3");
  });
});

describe("the daemon knows which store its own CLI writes to", () => {
  function daemonFor(config: Record<string, unknown>): { credentialProfileStore(): string | undefined } {
    const dir = tempDir();
    return new Daemon(
      "worker",
      { working_directory: dir, log_level: "silent", ...config } as never,
      dir, true, undefined, undefined,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) } as never,
    ) as unknown as { credentialProfileStore(): string | undefined };
  }

  it("points at its profile's store, one level down where kiro keeps its files", () => {
    const home = tempDir();
    process.env.AGEND_HOME = home;
    const daemon = daemonFor({
      backend: "kiro-cli",
      backend_options: { "kiro-cli": { credential_profile: "work" } },
    });

    expect(daemon.credentialProfileStore()).toBe(credentialProfileStoreHome(home, "kiro-cli", "work"));
    expect(daemon.credentialProfileStore()).toBe(join(home, "credential-profiles", "kiro-cli", "work", "kiro-cli"));
  });

  it("stays on the shared store with no profile, and reads the right namespace", () => {
    process.env.AGEND_HOME = tempDir();

    expect(daemonFor({ backend: "kiro-cli" }).credentialProfileStore()).toBeUndefined();
    // A profile written under another backend's namespace is not this one's.
    expect(daemonFor({
      backend: "kiro-cli",
      backend_options: { codex: { credential_profile: "work" } },
    }).credentialProfileStore()).toBeUndefined();
  });

  it("does not take the instance down over a malformed name", () => {
    process.env.AGEND_HOME = tempDir();
    const daemon = daemonFor({
      backend: "kiro-cli",
      backend_options: { "kiro-cli": { credential_profile: "../escape" } },
    });

    expect(() => daemon.credentialProfileStore()).not.toThrow();
    expect(daemon.credentialProfileStore()).toBeUndefined();
  });
});

// ── The one argument a type cannot check ────────────────────────────────────

describe("the transcript source is handed the store, not something else", () => {
  /** Top-level arguments of the first call to `fn`, as written in the source. */
  function callArgs(source: string, fn: string): string[] {
    const start = source.indexOf(`${fn}(`);
    expect(start, `${fn} is never called`).toBeGreaterThan(-1);
    const args: string[] = [];
    let depth = 0;
    let current = "";
    for (let i = start + fn.length; i < source.length; i++) {
      const char = source[i]!;
      if (char === "(") { depth++; if (depth === 1) continue; }
      if (char === ")") { depth--; if (depth === 0) { args.push(current); break; } }
      if (char === "," && depth === 1) { args.push(current); current = ""; continue; }
      current += char;
    }
    return args.map(a => a.trim()).filter(Boolean);
  }

  it("passes the working directory and the store in that order", () => {
    // Both are `string`, so swapping them compiles, runs, and quietly reads a
    // conversation database at the working directory's path — which does not
    // exist, so the transcript simply goes dark. Nothing else in this file can
    // catch that: each side is tested, the call between them is one expression.
    const daemonSource = readFileSync(new URL("../src/daemon.ts", import.meta.url), "utf8");

    const args = callArgs(daemonSource, "createTranscriptSource");

    expect(args).toHaveLength(3);
    expect(args[0]).toContain("this.config.backend");
    expect(args[1]).toBe("this.config.working_directory");
    expect(args[2]).toBe("this.credentialProfileStore()");
  });
});
