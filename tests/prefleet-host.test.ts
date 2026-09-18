import { readFileSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, request } from "node:http";
import { connect } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireFleetLock } from "../src/fleet-lock.js";
import { SetupHost } from "../src/setup-host.js";
import { clearSetupComplete, isSetupComplete, markSetupComplete } from "../src/setup-marker.js";
import { SETUP_FORM_HTML } from "../src/setup-form.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const dirs: string[] = [];
const hosts: SetupHost[] = [];

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
  const { port, token } = await host.start();
  return { host, dir, port, token, spawnFleet };
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

  it("redeems its link once and then only answers the cookie", async () => {
    const { port, token } = await startHost();

    const exchange = await raw(port, "GET", `/?token=${token}`);
    expect(exchange.status).toBe(302);
    const cookie = String(exchange.headers["set-cookie"]).split(";")[0]!;

    expect((await raw(port, "GET", "/", { cookie })).status).toBe(200);
    // The same link again: spent.
    expect((await raw(port, "GET", `/?token=${token}`)).status).toBe(401);
    expect((await raw(port, "GET", "/")).status).toBe(401);
  });

  it("rejects a cross-site request even with the cookie", async () => {
    const { port, token } = await startHost();
    const cookie = String((await raw(port, "GET", `/?token=${token}`)).headers["set-cookie"]).split(";")[0]!;

    const res = await raw(port, "POST", "/setup/finish", { cookie, origin: "https://evil.example" });

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

  it("writes a config a fleet can load", async () => {
    const { host, dir, port, token } = await startHost();
    const cookie = String((await raw(port, "GET", `/?token=${token}`)).headers["set-cookie"]).split(";")[0]!;

    const res = await new Promise<RawResponse>((resolve, reject) => {
      const payload = JSON.stringify({
        platform: "telegram", token_env: "AGEND_BOT_TOKEN", backend: "claude-code",
        working_directory: "/tmp/app", instance_name: "agent-1", group_id: "-100123",
        admin_user_id: "42", token: "123456:ABC",
      });
      const req = request({
        host: "127.0.0.1", port, method: "POST", path: "/api/settings/quickstart/commit",
        headers: { cookie, "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
      }, response => {
        let body = ""; response.on("data", (c: Buffer) => { body += c.toString(); });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
      });
      req.on("error", reject);
      req.end(payload);
    });

    expect(res.status).toBe(200);
    const { loadFleetConfig } = await import("../src/config.js");
    const written = loadFleetConfig(join(dir, "fleet.yaml"));
    expect(written.instances["agent-1"]).toMatchObject({ working_directory: "/tmp/app" });
    expect(readFileSync(join(dir, ".env"), "utf8")).toContain("AGEND_BOT_TOKEN=123456:ABC");
    expect(readdirSync(dir)).toContain("fleet.yaml");
    await host.shutdown(false, "done");
  }, 10_000);
});
