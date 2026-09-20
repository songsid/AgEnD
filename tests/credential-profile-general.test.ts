import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateFleetConfig } from "../src/config-validator.js";
import { credentialHomeSpec, prepareCredentialProfileHome } from "../src/backend/credential-profile.js";
import { outboundHandlers } from "../src/outbound-handlers.js";
import type { OutboundContext } from "../src/outbound-handlers.js";

const dirs: string[] = [];
const envBackup = { ...process.env };

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agend-profile-general-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (envBackup.XDG_DATA_HOME === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = envBackup.XDG_DATA_HOME;
  vi.restoreAllMocks();
});

// ── The config the operator (or General) writes ─────────────────────────────

function fleetWith(options: unknown) {
  return {
    defaults: {},
    instances: {
      worker: { working_directory: "/tmp/w", backend: "kiro-cli", backend_options: options },
    },
  };
}

describe("a profile is checked where it is entered", () => {
  it("accepts a plain name", () => {
    const result = validateFleetConfig(fleetWith({ "kiro-cli": { credential_profile: "work" } }));

    expect(result.errors).toEqual([]);
  });

  it("refuses a name that would leave its directory, before anything spawns", () => {
    // Without this the value is only checked at launch, so a typo surfaces
    // minutes later as a failed start rather than as a rejected edit.
    const result = validateFleetConfig(fleetWith({ "kiro-cli": { credential_profile: "../../etc" } }));

    expect(result.errors.map(e => e.path)).toContain("instances.worker.backend_options.kiro-cli.credential_profile");
    expect(result.valid).toBe(false);
  });

  it("refuses a value that is not a string", () => {
    // String(42) and String(true) are perfectly good directory names, which is
    // exactly the problem.
    for (const value of [42, true, ["work"], { name: "work" }]) {
      const result = validateFleetConfig(fleetWith({ "kiro-cli": { credential_profile: value } }));
      expect(result.errors.map(e => e.message).join(" "), JSON.stringify(value)).toContain("must be a string");
    }
  });

  it("warns, rather than fails, for a backend that has no profiles yet", () => {
    const result = validateFleetConfig(fleetWith({ codex: { credential_profile: "work" } }));

    expect(result.errors).toEqual([]);
    expect(result.warnings.map(w => w.message).join(" ")).toContain("no credential home yet");
  });
});

// ── The directory the profile lives in ──────────────────────────────────────

describe("a linked directory level is refused", () => {
  function sharedRoot(): string {
    const root = tempDir();
    mkdirSync(join(root, "kiro-cli"), { recursive: true });
    writeFileSync(join(root, "kiro-cli", "data.sqlite3"), "shared-login");
    return root;
  }

  it("refuses when the profile directory is a link to the shared home", () => {
    // mkdir -p follows the link and succeeds, and the store at the far end is a
    // real file, so nothing below this notices. Starting would bill the wrong
    // account while looking isolated.
    const root = sharedRoot();
    process.env.XDG_DATA_HOME = root;
    const home = join(tempDir(), "work");
    symlinkSync(root, home, "dir");

    expect(() => prepareCredentialProfileHome(credentialHomeSpec("kiro-cli")!, home))
      .toThrow(/is a symlink, so it is not isolated/);
  });

  it("refuses when only the store directory inside it is a link", () => {
    const root = sharedRoot();
    process.env.XDG_DATA_HOME = root;
    const home = join(tempDir(), "work");
    mkdirSync(home, { recursive: true });
    symlinkSync(join(root, "kiro-cli"), join(home, "kiro-cli"), "dir");

    expect(() => prepareCredentialProfileHome(credentialHomeSpec("kiro-cli")!, home))
      .toThrow(/is a symlink, so it is not isolated/);
  });

  it("leaves a real file sitting where a shared cache would go", () => {
    // "Never replaces" was only shown for a directory; a file is the other half.
    const root = sharedRoot();
    writeFileSync(join(root, "kiro-cli", "bun"), "shared-bun");
    process.env.XDG_DATA_HOME = root;
    const spec = credentialHomeSpec("kiro-cli")!;
    const home = join(tempDir(), "work");
    mkdirSync(join(home, "kiro-cli"), { recursive: true });
    writeFileSync(join(home, "kiro-cli", "bun"), "private-bun");

    prepareCredentialProfileHome(spec, home);

    expect(readFileSync(join(home, "kiro-cli", "bun"), "utf8")).toBe("private-bun");
  });
});

// ── What General actually calls ─────────────────────────────────────────────

function outboundContext(instance: Record<string, unknown>) {
  const restartSingleInstance = vi.fn(async () => {});
  const saveFleetConfig = vi.fn();
  const ctx = {
    fleetConfig: { defaults: {}, instances: { worker: instance } },
    classicChannels: { getAll: () => [] },
    saveFleetConfig,
    restartSingleInstance,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as unknown as OutboundContext;
  return { ctx, restartSingleInstance, saveFleetConfig, instance };
}

async function call(ctx: OutboundContext, tool: string, args: unknown): Promise<Record<string, unknown>> {
  let result: unknown = null;
  let error: string | undefined;
  let settled: (() => void) | null = null;
  const done = new Promise<void>(resolve => { settled = resolve; });
  await outboundHandlers.get(tool)!(ctx, args as never, (r, e) => {
    result = r; error = e; settled?.();
  }, {} as never);
  // The handler may answer from a promise callback rather than inline.
  await Promise.race([done, new Promise(r => setTimeout(r, 200))]);
  if (error) throw new Error(error);
  return result as Record<string, unknown>;
}

describe("moving an agent to another subscription", () => {
  it("writes the profile and restarts, because the CLI reads it at launch", async () => {
    const { ctx, restartSingleInstance, saveFleetConfig, instance } = outboundContext({
      working_directory: "/tmp/w", backend: "kiro-cli",
    });

    const result = await call(ctx, "update_instance_config", {
      name: "worker",
      config: { backend_options: { "kiro-cli": { credential_profile: "personal" } } },
    });

    expect(instance.backend_options).toEqual({ "kiro-cli": { credential_profile: "personal" } });
    expect(saveFleetConfig).toHaveBeenCalled();
    // Saving without restarting would report a switch that has not happened.
    expect(restartSingleInstance).toHaveBeenCalledWith("worker");
    expect(result).toMatchObject({ success: true, restarted: true });
  });

  it("merges per backend instead of replacing the whole map", async () => {
    const { ctx, instance } = outboundContext({
      working_directory: "/tmp/w", backend: "kiro-cli",
      backend_options: { codex: { provider: "glm" }, "kiro-cli": { credential_profile: "work" } },
    });

    await call(ctx, "update_instance_config", {
      name: "worker",
      config: { backend_options: { "kiro-cli": { credential_profile: "personal" } } },
    });

    expect(instance.backend_options).toEqual({
      codex: { provider: "glm" },
      "kiro-cli": { credential_profile: "personal" },
    });
  });

  it("merges inside a backend namespace too, so a sibling option survives", async () => {
    // The tool is a merge-patch. Replacing the namespace would drop whatever
    // else that backend was configured with — today there is little else to
    // drop, which is exactly when this stops being noticed.
    const { ctx, instance } = outboundContext({
      working_directory: "/tmp/w", backend: "kiro-cli",
      backend_options: { "kiro-cli": { credential_profile: "work", kiro_future_option: "keep me" } },
    });

    await call(ctx, "update_instance_config", {
      name: "worker",
      config: { backend_options: { "kiro-cli": { credential_profile: "personal" } } },
    });

    expect(instance.backend_options).toEqual({
      "kiro-cli": { credential_profile: "personal", kiro_future_option: "keep me" },
    });
  });

  it("does not restart when the value did not actually change", async () => {
    const { ctx, restartSingleInstance } = outboundContext({
      working_directory: "/tmp/w", backend: "kiro-cli",
      backend_options: { "kiro-cli": { credential_profile: "work" } },
    });

    const result = await call(ctx, "update_instance_config", {
      name: "worker",
      config: { backend_options: { "kiro-cli": { credential_profile: "work" } } },
    });

    expect(restartSingleInstance).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty("restarted");
  });

  it("leaves the other fields alone, and does not restart for them", async () => {
    const { ctx, restartSingleInstance, instance } = outboundContext({
      working_directory: "/tmp/w", backend: "kiro-cli",
    });

    await call(ctx, "update_instance_config", { name: "worker", config: { description: "a role" } });

    expect(instance.description).toBe("a role");
    expect(restartSingleInstance).not.toHaveBeenCalled();
  });

  it("reports a failed restart instead of claiming the switch happened", async () => {
    const { ctx, restartSingleInstance } = outboundContext({ working_directory: "/tmp/w", backend: "kiro-cli" });
    restartSingleInstance.mockRejectedValue(new Error("tmux is gone"));

    const result = await call(ctx, "update_instance_config", {
      name: "worker",
      config: { backend_options: { "kiro-cli": { credential_profile: "personal" } } },
    });

    expect(result).toMatchObject({ restarted: false });
    expect(String(result.warning)).toContain("tmux is gone");
  });
});

describe("the General skill", () => {
  const skill = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "general-knowledge", "skills", "credential-profiles", "SKILL.md"),
    "utf8",
  );

  it("is loadable by General", () => {
    expect(skill).toMatch(/^---\nname: credential-profiles\n/);
    expect(skill).toContain("roles: [general]");
  });

  it("tells General the two things it can do and the tool for each", () => {
    expect(skill).toContain("create_instance");
    expect(skill).toContain("update_instance_config");
    expect(skill).toContain("credential_profile");
  });

  it("warns about the three things that surprise a user", () => {
    // A profile nobody logged into, a restart that drops the conversation, and
    // two profiles on one billing account adding up to nothing.
    expect(skill).toMatch(/log ?in/i);
    expect(skill).toContain("restart");
    expect(skill).toMatch(/billing account|do not double/i);
  });

  it("says what no profile means, rather than leaving it blank", () => {
    expect(skill).toContain("the default login");
  });
});
