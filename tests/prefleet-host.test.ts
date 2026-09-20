import { readFileSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, request } from "node:http";
import { connect } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireFleetLock } from "../src/fleet-lock.js";
import { FleetManager } from "../src/fleet-manager.js";
import { SetupHost } from "../src/setup-host.js";
import { clearSetupComplete, isSetupComplete, markSetupComplete } from "../src/setup-marker.js";
import { SETUP_FORM_HTML } from "../src/setup-form.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const dirs: string[] = [];
const hosts: SetupHost[] = [];

function fleetOnConfig(lines: string[]) {
  const dir = tempDir();
  writeFileSync(join(dir, "fleet.yaml"), lines.join("\n"));
  const fm = new FleetManager(dir);
  fm.loadConfig(join(dir, "fleet.yaml"));
  return { fm, dir };
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agend-prefleet-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.shutdown(false, "test cleanup");
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ── Static isolation ────────────────────────────────────────────────────────

/** Every module reachable from an entry point by relative import. */
function importGraph(entry: string): string[] {
  const seen = new Set<string>();
  const stack = [join(SRC, entry)];
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    let source: string;
    try { source = readFileSync(file, "utf8"); } catch { continue; }
    const specifiers = [
      ...[...source.matchAll(/(?:from|import)\s+"(\.[^"]+)"/g)].map(m => m[1]!),
      ...[...source.matchAll(/import\("(\.[^"]+)"\)/g)].map(m => m[1]!),
    ];
    for (const specifier of specifiers) {
      const base = normalize(join(dirname(file), specifier)).replace(/\.js$/, ".ts");
      for (const candidate of [base, `${base}.ts`, join(base, "index.ts")]) {
        if (existsSync(candidate) && !seen.has(candidate)) { stack.push(candidate); break; }
      }
    }
  }
  return [...seen].map(file => file.slice(SRC.length + 1));
}

const FORBIDDEN = ["fleet-manager.ts", "daemon.ts", "instance-lifecycle.ts"];

describe("the setup host cannot reach the fleet", () => {
  it.each(["setup-host.ts", "quickstart-api.ts", "setup-form.ts", "setup-marker.ts"])(
    "%s imports nothing that can start, stop or reconfigure an agent",
    entry => {
      const graph = importGraph(entry);

      expect(graph.length).toBeGreaterThan(0);
      for (const forbidden of FORBIDDEN) {
        expect(graph, `${entry} can reach ${forbidden}`).not.toContain(forbidden);
      }
    },
  );

  it("sees a violation when one is introduced", () => {
    // The check is only worth having if it would actually catch an import, so
    // prove it on a module that does have one.
    expect(importGraph("web-api.ts").concat(importGraph("agent-endpoint.ts")))
      .toEqual(expect.arrayContaining([expect.stringMatching(/instance-lifecycle|fleet-manager|daemon/)]));
  });

  it("serves its own form, not the Settings panel", () => {
    expect(SETUP_FORM_HTML).toContain("Set up AgEnD");
    // The panel's markers must not appear: it drives a fleet this host has not
    // got, and it is a much larger surface than a form.
    for (const marker of ["pendingBar", "applyChanges", "Developer YAML", "agentSearch"]) {
      expect(SETUP_FORM_HTML, `the setup form embeds ${marker}`).not.toContain(marker);
    }
    const hostSource = readFileSync(join(SRC, "setup-host.ts"), "utf8");
    expect(hostSource).not.toContain("settings.html");
    expect(hostSource).not.toContain("readFileSync");
  });
});

// ── The marker ──────────────────────────────────────────────────────────────

describe("the setup-complete marker", () => {
  it("does not depend on fleet.yaml, so deleting the config cannot reopen setup", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "fleet.yaml"), "instances: {}\n");
    markSetupComplete(dir);

    rmSync(join(dir, "fleet.yaml"));

    expect(isSetupComplete(dir)).toBe(true);
  });

  it("treats a corrupt marker as done rather than as an invitation", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "setup-complete.json"), "{ truncated");

    expect(isSetupComplete(dir)).toBe(true);
  });

  it("is cleared only by an explicit reset", () => {
    const dir = tempDir();
    markSetupComplete(dir);

    expect(clearSetupComplete(dir)).toBe(true);
    expect(isSetupComplete(dir)).toBe(false);
  });
});

describe("an existing installation counts as set up", () => {
  it("records the marker when a fleet comes up on a config with agents", () => {
    // Installations that predate the marker would otherwise never have one, so
    // `agend setup` would open a pre-fleet form for a fleet that plainly exists.
    const { fm, dir } = fleetOnConfig(["instances:", "  one:", "    working_directory: /tmp/one", ""]);
    expect(isSetupComplete(dir)).toBe(false);

    (fm as unknown as { finishStartup(): void }).finishStartup();

    expect(isSetupComplete(dir)).toBe(true);
  });

  it("does not record it for a fleet with no agents yet", () => {
    const { fm, dir } = fleetOnConfig(["instances: {}", ""]);

    (fm as unknown as { finishStartup(): void }).finishStartup();

    expect(isSetupComplete(dir)).toBe(false);
  });
});

// ── The host ────────────────────────────────────────────────────────────────

interface RawResponse { status: number; headers: Record<string, string | string[] | undefined>; body: string }

function raw(port: number, method: string, path: string, headers: Record<string, string> = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers }, res => {
      let body = "";
      res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** Can something else take this port now? That is what the handover needs. */
function bindProbe(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

async function startHost(overrides: Partial<ConstructorParameters<typeof SetupHost>[0]> = {}) {
  const dir = overrides.dataDir ?? tempDir();
  const spawnFleet = vi.fn();
  const host = new SetupHost({
    dataDir: dir, configPath: join(dir, "fleet.yaml"), port: 0, spawnFleet, log: () => {}, ...overrides,
  });
  hosts.push(host);
  const { port, sid, code, path } = await host.start();
  return { host, dir, port, sid, code, path, spawnFleet };
}

/** Type the code in, the way the page does, and keep the cookie it hands back. */
async function signIn(port: number, path: string, code: string): Promise<string> {
  const res = await postJson(port, `${path}open`, { code });
  if (res.status !== 200) throw new Error(`sign-in failed: ${res.status} ${res.body}`);
  return String(res.headers["set-cookie"]).split(";")[0]!;
}

function postJson(port: number, path: string, body: unknown, headers: Record<string, string> = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = request({
      host: "127.0.0.1", port, method: "POST", path,
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload), ...headers },
    }, res => {
      let text = "";
      res.on("data", (chunk: Buffer) => { text += chunk.toString(); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

describe("the setup host", () => {
  it("refuses to start while a fleet holds the lock", async () => {
    const dir = tempDir();
    acquireFleetLock(dir, { pid: 4242, isProcessAlive: () => true, readCommandLine: () => "node cli.js fleet start" });
    const host = new SetupHost({
      dataDir: dir, configPath: join(dir, "fleet.yaml"), port: 0, log: () => {},
      lockProbe: { isProcessAlive: () => true, readCommandLine: () => "node cli.js fleet start" },
    });

    await expect(host.start()).rejects.toThrow(/already running/);
  });

  it("refuses an installation that already has agents, and points at the panel", async () => {
    // It writes fleet.yaml by dumping the loader's output — every default
    // expanded, every comment gone. Fine for a file it creates; destructive to
    // one somebody already has.
    const dir = tempDir();
    writeFileSync(join(dir, "fleet.yaml"), [
      "# hand-written, with comments",
      "instances:",
      "  one:",
      "    working_directory: /tmp/one",
      "",
    ].join("\n"));
    const before = readFileSync(join(dir, "fleet.yaml"), "utf8");
    const host = new SetupHost({ dataDir: dir, configPath: join(dir, "fleet.yaml"), port: 0, log: () => {} });

    await expect(host.start()).rejects.toThrow(/setup wizard there/);
    expect(readFileSync(join(dir, "fleet.yaml"), "utf8")).toBe(before);
  });

  it("claims the lock as a setup host, so a fleet cannot start beside it", async () => {
    const { dir } = await startHost();

    // Through the host's own start(), not by calling acquireFleetLock directly.
    expect(() => acquireFleetLock(dir, {
      pid: 4242,
      isProcessAlive: () => true,
      readCommandLine: pid => pid === process.pid ? "node cli.js setup" : "node cli.js fleet start",
    })).toThrow(/Setup is already running/);
  });

  it("serves a code prompt to the link alone, and the wizard only after the code", async () => {
    // The link is where the page lives, not permission to use it. Someone who
    // has only the link — a forwarded message, a preview fetch — gets a box to
    // type into and learns nothing about this machine.
    const { port, path, code } = await startHost();

    const anonymous = await raw(port, "GET", path);
    expect(anonymous.status).toBe(200);
    expect(anonymous.body).toContain("Enter the setup code");
    expect(anonymous.body).not.toContain("Working directory");

    const cookie = await signIn(port, path, code);
    const signedIn = await raw(port, "GET", path, { cookie });
    expect(signedIn.body).toContain("Working directory");
  });

  it("rejects a cross-site request even with the cookie", async () => {
    const { port, path, code } = await startHost();
    const cookie = await signIn(port, path, code);

    const res = await raw(port, "POST", `${path}setup/finish`, { cookie, origin: "https://evil.example" });

    expect(res.status).toBe(403);
  });

  it("lets go of the port before starting the fleet, even with a request in flight", async () => {
    // Measured during the spike: an unfinished connection stops close() from
    // completing, so the form would hang at "starting…" and the fleet would
    // never be spawned. A half-sent request is the cheap way to hold one open —
    // a dropped mobile connection looks the same to the server.
    const { host, port, spawnFleet } = await startHost();
    const stuck = connect(port, "127.0.0.1");
    await new Promise<void>(resolve => stuck.once("connect", () => resolve()));
    stuck.write("GET /setup/status HTTP/1.1\r\nHost: 127.0.0.1\r\n"); // no blank line: still in flight

    const closed = host.shutdown(true, "finished");
    await expect(Promise.race([
      closed.then(() => "closed"),
      new Promise(resolve => setTimeout(() => resolve("hung"), 3_000)),
    ])).resolves.toBe("closed");

    expect(spawnFleet).toHaveBeenCalledTimes(1);
    // The property that matters for the handover: the successor can bind it.
    await expect(bindProbe(port)).resolves.toBe(true);
    stuck.destroy();
  }, 10_000);

  it("marks setup complete only when it actually hands over", async () => {
    const { host, dir, spawnFleet } = await startHost();

    await host.shutdown(false, "ttl");

    expect(spawnFleet).not.toHaveBeenCalled();
    expect(isSetupComplete(dir)).toBe(false);
  });

  it("closes itself when its time is up", async () => {
    const { host, port, spawnFleet } = await startHost({ ttlMs: 60, idleMs: 60_000 });

    await vi.waitFor(async () => {
      await expect(bindProbe(port)).resolves.toBe(true);
    }, { timeout: 4_000 });
    expect(spawnFleet).not.toHaveBeenCalled();
    await host.shutdown(false, "already stopped");
  }, 10_000);

  it("releases the lock when it goes, so the fleet can start", async () => {
    const { host, dir } = await startHost();

    await host.shutdown(true, "finished");

    expect(() => acquireFleetLock(dir, { pid: 1234 })).not.toThrow();
  });

  it("does not keep itself alive for requests that are not for this page", async () => {
    // Otherwise a scanner that cannot find the page can still keep it open
    // forever by knocking on the wrong paths — the ten-minute idle window
    // becomes unbounded.
    const source = readFileSync(join(SRC, "setup-host.ts"), "utf8");
    const handle = source.slice(source.indexOf("private handle("));
    const sidAt = handle.indexOf("matchesSid(");
    const touchAt = handle.indexOf("this.touch()");

    expect(sidAt).toBeGreaterThan(-1);
    expect(touchAt, "idle timer refreshed before the sid was checked").toBeGreaterThan(sidAt);
  });

  it("writes a config a fleet can load", async () => {
    const { host, dir, port, path, code } = await startHost();
    const cookie = await signIn(port, path, code);

    const res = await postJson(port, `${path}api/settings/quickstart/commit`, {
      platform: "telegram", token_env: "AGEND_BOT_TOKEN", backend: "claude-code",
      working_directory: "/tmp/app", instance_name: "agent-1", group_id: "-100123",
      admin_user_id: "42", token: "123456:ABC",
    }, { cookie });

    expect(res.status).toBe(200);
    const { loadFleetConfig } = await import("../src/config.js");
    const written = loadFleetConfig(join(dir, "fleet.yaml"));
    expect(written.instances["agent-1"]).toMatchObject({ working_directory: "/tmp/app" });
    expect(readFileSync(join(dir, ".env"), "utf8")).toContain("AGEND_BOT_TOKEN=123456:ABC");
    expect(readdirSync(dir)).toContain("fleet.yaml");
    await host.shutdown(false, "done");
  }, 10_000);
});
