import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { fetchAllUsage, fetchKiroUsage, providersForConfig, setUsageProvidersForTests } from "../src/usage/providers.js";
import { listConfiguredProfiles, instanceCredentialProfile } from "../src/backend/credential-profile.js";

const dirs: string[] = [];
const envBackup = { ...process.env };

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agend-usage-profile-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  setUsageProvidersForTests(null);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const key of ["AGEND_HOME", "KIRO_CLI_HOME"]) {
    if (envBackup[key] === undefined) delete process.env[key];
    else process.env[key] = envBackup[key];
  }
  vi.restoreAllMocks();
});

function configWith(profiles: Array<string | null>) {
  const instances: Record<string, unknown> = {};
  profiles.forEach((profile, index) => {
    instances[`agent-${index}`] = {
      working_directory: "/tmp/w", backend: "kiro-cli",
      ...(profile ? { backend_options: { "kiro-cli": { credential_profile: profile } } } : {}),
    };
  });
  return { defaults: {}, instances } as never;
}

describe("which subscriptions a fleet uses", () => {
  it("lists each profile once, however many agents share it", () => {
    // Agents on one profile share one login and one quota: one row, not three.
    expect(listConfiguredProfiles(configWith(["work", "work", "personal"]), "kiro-cli"))
      .toEqual(["personal", "work"]);
  });

  it("is empty when nothing opted in", () => {
    expect(listConfiguredProfiles(configWith([null, null]), "kiro-cli")).toEqual([]);
    expect(listConfiguredProfiles(null, "kiro-cli")).toEqual([]);
  });

  it("includes a profile set as a fleet default", () => {
    const config = { defaults: { backend_options: { "kiro-cli": { credential_profile: "team" } } }, instances: {} };

    expect(listConfiguredProfiles(config as never, "kiro-cli")).toEqual(["team"]);
  });

  it("ignores a malformed name rather than throwing while only reading", () => {
    const config = configWith([]) as unknown as { instances: Record<string, unknown> };
    config.instances.bad = { backend_options: { "kiro-cli": { credential_profile: "../escape" } } };

    expect(() => listConfiguredProfiles(config as never, "kiro-cli")).not.toThrow();
    expect(listConfiguredProfiles(config as never, "kiro-cli")).toEqual([]);
  });

  it("reads an instance's own profile, falling back to the fleet default", () => {
    const defaults = { backend_options: { "kiro-cli": { credential_profile: "team" } } };

    expect(instanceCredentialProfile({ backend_options: { "kiro-cli": { credential_profile: "mine" } } }, defaults, "kiro-cli")).toBe("mine");
    expect(instanceCredentialProfile({}, defaults, "kiro-cli")).toBe("team");
    expect(instanceCredentialProfile({}, {}, "kiro-cli")).toBeNull();
  });
});

describe("one usage row per subscription", () => {
  const base = [
    { id: "claude", name: "Claude", fetch: async () => ({ status: "ok" as const, metrics: [] }) },
    { id: "kiro", name: "Kiro", fetch: async (home?: string) => ({ status: "ok" as const, plan: home ?? "shared", metrics: [] }) },
  ];

  it("leaves a fleet with no profiles exactly as it was", () => {
    const rows = providersForConfig(configWith([null]), base);

    expect(rows.map(r => r.id)).toEqual(["claude", "kiro"]);
    expect(rows.map(r => r.name)).toEqual(["Claude", "Kiro"]);
  });

  it("gives each profile its own row, named so a human can tell them apart", () => {
    const rows = providersForConfig(configWith(["work", "personal"]), base);

    expect(rows.map(r => r.id)).toEqual(["claude", "kiro:personal", "kiro:work"]);
    expect(rows.map(r => r.name)).toEqual(["Claude", "Kiro (personal)", "Kiro (work)"]);
  });

  it("points each row at its own store", async () => {
    process.env.AGEND_HOME = "/data";
    const rows = providersForConfig(configWith(["work", "personal"]), base);

    const plans = await Promise.all(rows.slice(1).map(r => r.fetch()));

    // The store, not the profile home: kiro keeps its files one level down.
    expect(plans.map(p => (p as { plan: string }).plan)).toEqual([
      "/data/credential-profiles/kiro-cli/personal/kiro-cli",
      "/data/credential-profiles/kiro-cli/work/kiro-cli",
    ]);
  });

  it("does not touch a backend that has no credential home yet", () => {
    // claude-code has no credential home yet, so a profile written against
    // it is configuration with nothing to act on — and must not grow a row.
    const config = { defaults: {}, instances: { a: { backend: "claude-code", backend_options: { "claude-code": { credential_profile: "work" } } } } };

    const rows = providersForConfig(config as never, base);

    expect(rows.map(r => r.id)).toEqual(["claude", "kiro"]);
  });
});

describe("reading two stores", () => {
  /** A minimal kiro store with one Builder-ID login in it. */
  function makeStore(dir: string, accessToken: string): string {
    mkdirSync(dir, { recursive: true });
    const db = new Database(join(dir, "data.sqlite3"));
    db.exec("CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)");
    db.prepare("INSERT INTO auth_kv (key, value) VALUES (?, ?)").run(
      "kirocli:odic:token",
      JSON.stringify({
        access_token: accessToken,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        region: "us-east-1",
        start_url: "https://view.awsapps.com/start",
      }),
    );
    db.close();
    return dir;
  }

  it("reads each profile's own store, and neither is the shared one", async () => {
    const dataDir = tempDir();
    process.env.AGEND_HOME = dataDir;
    const shared = makeStore(join(tempDir(), "kiro-cli"), "shared-token");
    process.env.KIRO_CLI_HOME = shared;
    makeStore(join(dataDir, "credential-profiles", "kiro-cli", "work", "kiro-cli"), "work-token");
    makeStore(join(dataDir, "credential-profiles", "kiro-cli", "personal", "kiro-cli"), "personal-token");
    const sharedBefore = statSync(join(shared, "data.sqlite3"));

    const seen: string[] = [];
    setUsageProvidersForTests([{
      id: "kiro", name: "Kiro",
      fetch: async (home?: string) => { seen.push(home ?? "(shared)"); return { status: "ok", metrics: [] }; },
    }]);

    const payload = await fetchAllUsage(configWith(["work", "personal"]));

    expect(payload.providers.map(p => p.id)).toEqual(["kiro:personal", "kiro:work"]);
    expect(seen.sort()).toEqual([
      join(dataDir, "credential-profiles", "kiro-cli", "personal", "kiro-cli"),
      join(dataDir, "credential-profiles", "kiro-cli", "work", "kiro-cli"),
    ]);
    // Never the shared login, and never written to.
    expect(seen).not.toContain(shared);
    const sharedAfter = statSync(join(shared, "data.sqlite3"));
    expect(sharedAfter.mtimeMs).toBe(sharedBefore.mtimeMs);
    expect(sharedAfter.size).toBe(sharedBefore.size);
  });

  it("keeps the two rows apart instead of adding them up", async () => {
    process.env.AGEND_HOME = tempDir();
    setUsageProvidersForTests([{
      id: "kiro", name: "Kiro",
      fetch: async (home?: string) => ({
        status: "ok",
        metrics: [{ id: "credits", label: "Credits", type: "percent", used: home?.includes("work") ? 80 : 10, limit: 100 }],
      }),
    }] as never);

    const payload = await fetchAllUsage(configWith(["work", "personal"]));

    // Two quotas: a single summed row would be true of neither account.
    expect(payload.providers.map(p => [p.id, p.metrics[0]?.used])).toEqual([
      ["kiro:personal", 10],
      ["kiro:work", 80],
    ]);
  });

  it("still shows one shared row when no profile is configured", async () => {
    process.env.AGEND_HOME = tempDir();
    setUsageProvidersForTests([{
      id: "kiro", name: "Kiro",
      fetch: async (home?: string) => ({ status: "ok", plan: home ?? "shared", metrics: [] }),
    }] as never);

    const payload = await fetchAllUsage(configWith([null]));

    expect(payload.providers.map(p => p.id)).toEqual(["kiro"]);
    expect(payload.providers[0]!.plan).toBe("shared");
  });
});

describe("the active-row filter follows the profile", () => {
  it("lights up the row the instance actually runs on", async () => {
    // Filtering by the bare backend id would hide every profile row, because
    // the rows are called kiro:work and kiro:personal.
    const { FleetManager } = await import("../src/fleet-manager.js");
    const dir = tempDir();
    writeFileSync(join(dir, "fleet.yaml"), [
      "instances:",
      "  work-agent:",
      "    working_directory: /tmp/w",
      "    backend: kiro-cli",
      "    backend_options:",
      "      kiro-cli:",
      "        credential_profile: work",
      "  plain-agent:",
      "    working_directory: /tmp/p",
      "    backend: claude-code",
      "",
    ].join("\n"));
    const fm = new FleetManager(dir);
    fm.loadConfig(join(dir, "fleet.yaml"));
    vi.spyOn(fm, "getInstanceStatus").mockReturnValue("running");

    expect([...fm.getActiveUsageProviderIds()].sort()).toEqual(["claude", "kiro:work"]);
    // The backend view is unchanged for everything that still asks for it.
    expect([...fm.getActiveBackendIds()].sort()).toEqual(["claude-code", "kiro-cli"]);
  });

  it("leaves a fleet with no profiles reporting the plain ids", async () => {
    const { FleetManager } = await import("../src/fleet-manager.js");
    const dir = tempDir();
    writeFileSync(join(dir, "fleet.yaml"), [
      "instances:", "  one:", "    working_directory: /tmp/w", "    backend: kiro-cli", "",
    ].join("\n"));
    const fm = new FleetManager(dir);
    fm.loadConfig(join(dir, "fleet.yaml"));
    vi.spyOn(fm, "getInstanceStatus").mockReturnValue("running");

    expect([...fm.getActiveUsageProviderIds()]).toEqual(["kiro"]);
  });

  it("ignores instances that are neither running nor paused", async () => {
    const { FleetManager } = await import("../src/fleet-manager.js");
    const dir = tempDir();
    writeFileSync(join(dir, "fleet.yaml"), [
      "instances:", "  one:", "    working_directory: /tmp/w", "    backend: kiro-cli",
      "    backend_options:", "      kiro-cli:", "        credential_profile: work", "",
    ].join("\n"));
    const fm = new FleetManager(dir);
    fm.loadConfig(join(dir, "fleet.yaml"));
    vi.spyOn(fm, "getInstanceStatus").mockReturnValue("stopped");

    expect([...fm.getActiveUsageProviderIds()]).toEqual([]);
  });
});

describe("the real kiro reader against a real store", () => {
  /** A kiro store on disk. `login: null` writes the schema with nobody in it. */
  function makeStore(dir: string, login: { accessToken: string; qPro: boolean } | null): string {
    mkdirSync(dir, { recursive: true });
    const db = new Database(join(dir, "data.sqlite3"));
    db.exec("CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)");
    if (login) {
      db.prepare("INSERT INTO auth_kv (key, value) VALUES (?, ?)").run(
        "kirocli:odic:token",
        JSON.stringify({
          access_token: login.accessToken,
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          region: "us-east-1",
          // A Q Developer Pro login reports its plan without any network call,
          // which is what keeps this test offline and deterministic.
          ...(login.qPro ? { start_url: "https://view.awsapps.com/start" } : {}),
        }),
      );
    }
    db.close();
    return dir;
  }

  it("opens the store it was handed, not the shared login", async () => {
    // Both stores are real and readable, and they answer differently — so this
    // fails if the argument is ignored, rather than only if the fallback is
    // absent from the machine.
    const profileStore = makeStore(join(tempDir(), "kiro-cli"), { accessToken: "work-token", qPro: true });
    process.env.KIRO_CLI_HOME = makeStore(join(tempDir(), "kiro-cli"), null);
    const before = statSync(join(profileStore, "data.sqlite3"));

    const usage = await fetchKiroUsage(profileStore);

    expect(usage.plan).toBe("Q Developer Pro");
    // The shared store's answer, which a dropped argument would return instead.
    expect((await fetchKiroUsage()).plan).toBe("Kiro");
    const after = statSync(join(profileStore, "data.sqlite3"));
    expect([after.mtimeMs, after.size]).toEqual([before.mtimeMs, before.size]);
  });

  it("says a configured subscription is signed out instead of dropping its row", async () => {
    // The store does not exist because nobody has run `kiro-cli login` for this
    // profile yet. kiro-cli is plainly installed — the fleet is running it — so
    // this is the reminder to go and log in, not a reason to hide the row.
    const dataDir = tempDir();
    process.env.AGEND_HOME = dataDir;
    // Pointed away from the developer's own login, so this never reads it —
    // including when a regression makes the reader fall back to the shared store.
    process.env.KIRO_CLI_HOME = join(tempDir(), "nowhere");
    setUsageProvidersForTests([{ id: "kiro", name: "Kiro", fetch: fetchKiroUsage }]);

    const payload = await fetchAllUsage(configWith(["work"]));

    expect(payload.providers.map(p => [p.id, p.status])).toEqual([["kiro:work", "ok"]]);
    expect(payload.providers[0]!.hint).toContain("Signed out");
  });

  it("still lets the shared row vanish when kiro-cli is not on this machine", async () => {
    // The other direction: without a profile, an absent store means the CLI
    // isn't here, and the panel should not carry a row for it.
    process.env.AGEND_HOME = tempDir();
    process.env.KIRO_CLI_HOME = join(tempDir(), "nowhere");
    setUsageProvidersForTests([{ id: "kiro", name: "Kiro", fetch: fetchKiroUsage }]);

    const payload = await fetchAllUsage(configWith([null]));

    expect(payload.providers).toEqual([]);
  });

  it("reads fleet.yaml itself when the caller passes no config", async () => {
    // /usage, the dashboard and get_usage all call fetchAllUsage() bare. If it
    // did not look the profiles up, every one of them would show the old single
    // shared row and the second subscription would be invisible.
    const dataDir = tempDir();
    process.env.AGEND_HOME = dataDir;
    writeFileSync(join(dataDir, "fleet.yaml"), [
      "instances:",
      "  work-agent:",
      "    working_directory: /tmp/w",
      "    backend: kiro-cli",
      "    backend_options:",
      "      kiro-cli:",
      "        credential_profile: work",
      "",
    ].join("\n"));
    setUsageProvidersForTests([{
      id: "kiro", name: "Kiro",
      fetch: async (home?: string) => ({ status: "ok", plan: home ?? "shared", metrics: [] }),
    }] as never);

    const payload = await fetchAllUsage();

    expect(payload.providers.map(p => p.id)).toEqual(["kiro:work"]);
    expect(payload.providers[0]!.plan).toBe(join(dataDir, "credential-profiles", "kiro-cli", "work", "kiro-cli"));
  });
});
