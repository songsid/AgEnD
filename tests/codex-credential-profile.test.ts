import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexBackend } from "../src/backend/codex.js";
import {
  credentialHomeSpec,
  credentialProfileLogin,
  credentialSwitchStartsFresh,
  prepareCredentialProfileHome,
} from "../src/backend/credential-profile.js";
import { providersForConfig } from "../src/usage/providers.js";

const dirs: string[] = [];
const envBackup = { ...process.env };

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agend-codex-profile-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const key of ["AGEND_HOME", "CODEX_HOME"]) {
    if (envBackup[key] === undefined) delete process.env[key];
    else process.env[key] = envBackup[key];
  }
  vi.restoreAllMocks();
});

/** A codex home with a login in it, standing in for `~/.codex`. */
function sharedHome(opts: { login?: boolean } = {}): string {
  const dir = join(tempDir(), "codex");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.toml"), 'model = "gpt-5.6-sol"\n');
  mkdirSync(join(dir, "sessions"), { recursive: true });
  writeFileSync(join(dir, "thread_history_1.sqlite"), "not really sqlite, but a file");
  writeFileSync(join(dir, "thread_history_1.sqlite-wal"), "sidecar");
  if (opts.login !== false) {
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "shared-token" } }));
  }
  process.env.CODEX_HOME = dir;
  return dir;
}

function profileAuth(dataDir: string, profile: string, token = "profile-token"): string {
  const dir = join(dataDir, "credential-profiles", "codex", profile);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: token } }), { mode: 0o600 });
  return dir;
}

function launch(instanceDir: string, profile?: string): string {
  const backend = new CodexBackend(instanceDir);
  backend.writeConfig({
    workingDirectory: instanceDir, instanceDir, instanceName: "probe", mcpServers: {},
    ...(profile ? { backendOptions: { credential_profile: profile } } : {}),
  } as never);
  return join(instanceDir, "codex-home", "auth.json");
}

// ── Two shapes of credential home ───────────────────────────────────────────

describe("codex is a different shape of credential home", () => {
  it("redirects one file instead of relocating the home", () => {
    // CODEX_HOME is already taken: every instance has its own so that its
    // config.toml is private. A profile cannot move it again, and does not need
    // to — the whole login is one file.
    expect(credentialHomeSpec("codex")).toMatchObject({
      kind: "redirect-files",
      files: ["auth.json"],
      storeSubdir: "",
    });
    expect(credentialHomeSpec("kiro-cli")).toMatchObject({ kind: "relocate-home" });
  });

  it("makes a profile directory without linking anything into it", () => {
    // The backend's home stays where it is, so there is nothing to link back —
    // which is the difference from kiro, where the profile IS the home.
    const spec = credentialHomeSpec("codex")!;
    const home = join(tempDir(), "credential-profiles", "codex", "work");

    prepareCredentialProfileHome(spec, home);

    expect(existsSync(home)).toBe(true);
    expect(statSync(home).mode & 0o777).toBe(0o700);
  });

  it("refuses a profile whose auth.json is a link back to the shared login", () => {
    // Otherwise the profile is the shared login wearing a different name — the
    // same trap as a symlinked store, one level down.
    const shared = sharedHome();
    const spec = credentialHomeSpec("codex")!;
    const home = join(tempDir(), "credential-profiles", "codex", "work");
    mkdirSync(home, { recursive: true });
    require("node:fs").symlinkSync(join(shared, "auth.json"), join(home, "auth.json"));

    expect(() => prepareCredentialProfileHome(spec, home)).toThrow(/shares the login it exists to separate/);
  });

  it("knows a codex profile keeps its conversation and a kiro one does not", () => {
    expect(credentialSwitchStartsFresh("codex")).toBe(false);
    expect(credentialSwitchStartsFresh("kiro-cli")).toBe(true);
  });
});

// ── The one link that moves ─────────────────────────────────────────────────

describe("which login an instance's codex home points at", () => {
  it("uses the shared login when no profile is set", () => {
    const shared = sharedHome();
    process.env.AGEND_HOME = tempDir();

    const link = launch(tempDir());

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(resolve(readlinkSync(link))).toBe(join(shared, "auth.json"));
  });

  it("uses the profile's own file when one is set", () => {
    sharedHome();
    const dataDir = tempDir();
    process.env.AGEND_HOME = dataDir;
    const profile = profileAuth(dataDir, "work");

    const link = launch(tempDir(), "work");

    expect(resolve(readlinkSync(link))).toBe(join(profile, "auth.json"));
    expect(readFileSync(link, "utf8")).toContain("profile-token");
  });

  it("leaves everything else coming from the shared home", () => {
    // This is why a codex switch keeps the conversation: sessions and the
    // thread databases never move.
    sharedHome();
    const dataDir = tempDir();
    process.env.AGEND_HOME = dataDir;
    profileAuth(dataDir, "work");
    const instanceDir = tempDir();

    launch(instanceDir, "work");
    const home = join(instanceDir, "codex-home");

    expect(lstatSync(join(home, "sessions")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(home, "thread_history_1.sqlite")).isSymbolicLink()).toBe(true);
    // The sidecar is still never linked: that is what splits a database's file
    // set across two homes.
    expect(existsSync(join(home, "thread_history_1.sqlite-wal"))).toBe(false);
    // And config.toml is still this instance's own.
    expect(lstatSync(join(home, "config.toml")).isSymbolicLink()).toBe(false);
  });

  it("moves the link when the profile changes, and back again", () => {
    const shared = sharedHome();
    const dataDir = tempDir();
    process.env.AGEND_HOME = dataDir;
    const work = profileAuth(dataDir, "work");
    const instanceDir = tempDir();

    const link = launch(instanceDir);
    expect(resolve(readlinkSync(link))).toBe(join(shared, "auth.json"));

    launch(instanceDir, "work");
    expect(resolve(readlinkSync(link))).toBe(join(work, "auth.json"));

    // Back to the default login: the way out of a bad switch.
    launch(instanceDir);
    expect(resolve(readlinkSync(link))).toBe(join(shared, "auth.json"));
  });

  it("keeps working when the profile has not been logged into yet", () => {
    // No auth.json to link. codex will create one when the person logs in, and
    // the instance must not fail to start in the meantime.
    sharedHome();
    const dataDir = tempDir();
    process.env.AGEND_HOME = dataDir;
    mkdirSync(join(dataDir, "credential-profiles", "codex", "empty"), { recursive: true });

    const link = launch(tempDir(), "empty");

    expect(existsSync(link)).toBe(false);
  });

  it("does not fall back to the shared login for a malformed profile name", () => {
    // A bad name is refused where it is written. Launching is not the place to
    // discover it — but silently using the wrong subscription would be worse
    // than starting on the default one, so this pins which it does.
    sharedHome();
    process.env.AGEND_HOME = tempDir();
    const instanceDir = tempDir();

    const backend = new CodexBackend(instanceDir);
    expect(() => backend.writeConfig({
      workingDirectory: instanceDir, instanceDir, instanceName: "probe", mcpServers: {},
      backendOptions: { credential_profile: "../escape" },
    } as never)).not.toThrow();

    const link = join(instanceDir, "codex-home", "auth.json");
    expect(resolve(readlinkSync(link))).toBe(join(process.env.CODEX_HOME!, "auth.json"));
  });
});

// ── The guard for the day codex stops writing through the link ──────────────

describe("a real auth.json where a link belongs", () => {
  it("is kept, reported, and replaced by the link", () => {
    // Codex refreshes the token through the symlink today — observed across
    // every instance home on a machine that has run this for months. If a
    // release starts renaming over it instead, the login forks silently and
    // refreshes land somewhere the profile never sees. So this is noticed.
    sharedHome();
    const dataDir = tempDir();
    process.env.AGEND_HOME = dataDir;
    const profile = profileAuth(dataDir, "work");
    const instanceDir = tempDir();
    launch(instanceDir, "work");

    const link = join(instanceDir, "codex-home", "auth.json");
    rmSync(link);
    writeFileSync(link, JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "refreshed-but-stranded" } }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    launch(instanceDir, "work");

    expect(resolve(readlinkSync(link))).toBe(join(profile, "auth.json"));
    expect(warn.mock.calls.flat().join(" ")).toContain("no longer shared");
    // The stranded refreshes are not deleted: they are somebody's live login.
    const kept = require("node:fs").readdirSync(join(instanceDir, "codex-home"))
      .find((n: string) => n.startsWith("auth.json.replaced-"));
    expect(kept, "the replaced file was thrown away").toBeTruthy();
    expect(readFileSync(join(instanceDir, "codex-home", kept!), "utf8")).toContain("refreshed-but-stranded");
  });
});

// ── Usage ───────────────────────────────────────────────────────────────────

describe("one usage row per codex subscription", () => {
  const base = [
    { id: "codex", name: "Codex", fetch: async (home?: string) => ({ status: "ok" as const, plan: home ?? "shared", metrics: [] }) },
  ];

  it("gives each configured codex profile its own row", () => {
    const config = {
      defaults: {},
      instances: {
        a: { backend: "codex", backend_options: { codex: { credential_profile: "work" } } },
        b: { backend: "codex", backend_options: { codex: { credential_profile: "personal" } } },
      },
    };

    const rows = providersForConfig(config as never, base);

    expect(rows.map(r => r.id)).toEqual(["codex:personal", "codex:work"]);
    expect(rows.map(r => r.name)).toEqual(["Codex (personal)", "Codex (work)"]);
  });

  it("points each row at the profile directory itself, with no store subdir", async () => {
    // codex keeps auth.json at the top of its home, unlike kiro's one-level-down
    // store — so the row must read the profile directory, not a subdirectory.
    process.env.AGEND_HOME = "/data";
    const rows = providersForConfig({
      defaults: {}, instances: { a: { backend: "codex", backend_options: { codex: { credential_profile: "work" } } } },
    } as never, base);

    const plan = (await rows[0]!.fetch()) as { plan: string };

    expect(plan.plan).toBe("/data/credential-profiles/codex/work");
  });

  it("leaves a fleet with no codex profiles exactly as it was", () => {
    const rows = providersForConfig({ defaults: {}, instances: { a: { backend: "codex" } } } as never, base);

    expect(rows.map(r => r.id)).toEqual(["codex"]);
  });

  it("reads the profile's auth.json rather than the shared one", async () => {
    // The two stores are made to answer differently, and both answers come
    // back without a network call — so this fails if the argument is ignored,
    // rather than only on a machine where one of them happens to be absent.
    const { fetchCodexUsage } = await import("../src/usage/providers.js");
    const shared = sharedHome({ login: false }); // no auth.json at all
    const dataDir = tempDir();
    const dir = join(dataDir, "credential-profiles", "codex", "work");
    mkdirSync(dir, { recursive: true });
    // An expired JWT: reported as expired without asking chatgpt.com anything.
    const expired = [
      Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
      Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 3600 })).toString("base64url"),
      "sig",
    ].join(".");
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: expired } }));

    const fromProfile = await fetchCodexUsage(dir);
    const fromShared = await fetchCodexUsage();

    expect(fromProfile).toMatchObject({ status: "error" });
    expect(fromProfile.error).toContain("expired");
    // The shared home has no login at all, which is a different answer.
    expect(fromShared).toMatchObject({ status: "no-credentials" });
    expect(existsSync(join(shared, "auth.json"))).toBe(false);
  });
});

// ── The login gate agrees with codex ────────────────────────────────────────

describe("whether a codex profile has been logged into", () => {
  it("sees a token, and sees when there is none", () => {
    const dataDir = tempDir();
    profileAuth(dataDir, "work");
    mkdirSync(join(dataDir, "credential-profiles", "codex", "empty"), { recursive: true });

    expect(credentialProfileLogin(dataDir, "codex", "work")).toEqual({ state: "logged-in" });
    expect(credentialProfileLogin(dataDir, "codex", "empty").state).toBe("signed-out");
    expect(credentialProfileLogin(dataDir, "codex", "absent").state).toBe("signed-out");
  });

  it("counts an API-key login, because codex will start on one", () => {
    const dataDir = tempDir();
    const dir = join(dataDir, "credential-profiles", "codex", "keyed");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-x", tokens: null }));

    // Whether it can report usage is a different question from whether the
    // agent can start, and this gate is about starting.
    expect(credentialProfileLogin(dataDir, "codex", "keyed")).toEqual({ state: "logged-in" });
  });

  it("hands back the command with CODEX_HOME pointed at the profile", () => {
    const dataDir = tempDir();
    const login = credentialProfileLogin(dataDir, "codex", "personal");

    const command = (login as { loginCommand: string }).loginCommand;
    expect(command).toContain("CODEX_HOME=");
    expect(command).toContain(join(dataDir, "credential-profiles", "codex", "personal"));
    expect(command).toMatch(/codex login$/);
  });
});

// ── Falling back cleanly is a property of the launch command ────────────────

describe("if a resumed session cannot be opened", () => {
  it("has a fresh-start command form that carries no resume", () => {
    // Whether codex will reopen a thread recorded under a different account is
    // the one thing nobody has been able to test — so what matters here is that
    // there is a fresh path to fall back to. The daemon's resume-failure
    // recovery sets skipResume and takes it; it is backend-agnostic and already
    // covered by its own tests.
    const backend = new CodexBackend(tempDir());
    const config = { workingDirectory: "/tmp/w", instanceDir: tempDir(), instanceName: "p", mcpServers: {} };

    const resuming = backend.buildCommand({ ...config } as never);
    const fresh = backend.buildCommand({ ...config, skipResume: true } as never);

    expect(resuming).toContain("resume --last");
    expect(fresh).not.toContain("resume");
  });
});
