import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OpenCodeBackend } from "../../src/backend/opencode.js";
import type { CliBackendConfig } from "../../src/backend/types.js";
import { Daemon } from "../../src/daemon.js";
import pino from "pino";
import type { Logger } from "../../src/logger.js";

// Use unique temp directories per test run to avoid collisions when multiple
// vitest processes run in parallel (issue #669)
const TEST_DIR = mkdtempSync(join(tmpdir(), "ccd-test-opencode-backend-"));
const WORK_DIR = mkdtempSync(join(tmpdir(), "ccd-test-opencode-workdir-"));
const rootLogger = pino({ level: "silent" }) as Logger;

function makeConfig(overrides?: Partial<CliBackendConfig>): CliBackendConfig {
  return {
    workingDirectory: WORK_DIR,
    instanceDir: TEST_DIR,
    instanceName: "test-oc",
    mcpServers: {
      "agend": {
        command: "node",
        args: ["/path/to/mcp-server.js"],
        env: { AGEND_SOCKET_PATH: "/tmp/test.sock" },
      },
    },
    ...overrides,
  };
}

describe("OpenCodeBackend", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    mkdirSync(WORK_DIR, { recursive: true });
  });
  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    rmSync(WORK_DIR, { recursive: true, force: true });
  });

  describe("buildCommand", () => {
    it("starts a new cwd-local session when no persisted session id exists", () => {
      const backend = new OpenCodeBackend(TEST_DIR);

      const command = backend.buildCommand(makeConfig());

      expect(command).not.toContain("--continue");
      expect(command).not.toContain("--session");
    });

    it("resumes the explicitly persisted instance session", () => {
      writeFileSync(join(TEST_DIR, "session-id"), "session-123\n");
      const backend = new OpenCodeBackend(TEST_DIR);

      const command = backend.buildCommand(makeConfig());

      expect(command).toContain("--session session-123");
      expect(command).not.toContain("--continue");
    });
  });

  describe("writeConfig", () => {
    it("writes fleet-instructions.md and adds to instructions", () => {
      const backend = new OpenCodeBackend(TEST_DIR);
      backend.writeConfig(makeConfig({ instructions: "# Fleet Context" }));
      const instrFile = join(TEST_DIR, "fleet-instructions.md");
      expect(existsSync(instrFile)).toBe(true);
      expect(readFileSync(instrFile, "utf-8")).toContain("# Fleet Context");
      const oc = JSON.parse(readFileSync(join(WORK_DIR, "opencode.json"), "utf-8"));
      expect(oc.instructions).toContain(instrFile);
    });

    it("does not add instructions when instructions absent", () => {
      const backend = new OpenCodeBackend(TEST_DIR);
      backend.writeConfig(makeConfig());
      const oc = JSON.parse(readFileSync(join(WORK_DIR, "opencode.json"), "utf-8"));
      expect(oc.instructions).toBeUndefined();
    });

    it("preserves existing instructions", () => {
      writeFileSync(join(WORK_DIR, "opencode.json"), JSON.stringify({ instructions: ["/existing/path.md"] }));
      const backend = new OpenCodeBackend(TEST_DIR);
      backend.writeConfig(makeConfig({ instructions: "# Fleet" }));
      const oc = JSON.parse(readFileSync(join(WORK_DIR, "opencode.json"), "utf-8"));
      expect(oc.instructions).toContain("/existing/path.md");
      expect(oc.instructions).toContain(join(TEST_DIR, "fleet-instructions.md"));
    });
  });

  describe("getErrorPatterns", () => {
    const patterns = new OpenCodeBackend(TEST_DIR).getErrorPatterns();
    const match = (pane: string) => patterns.find(pattern => pattern.pattern.test(pane));

    it.each([
      ["■ 429 Too Many Requests", "rate_limit", "failover"],
      ["⚠ rate limit exceeded", "rate_limit", "failover"],
      ["Error: provider returned too many requests", "rate_limit", "failover"],
      ["■ {\"status\":401,\"error\":\"Unauthorized\"}", "auth_error", "pause"],
      ["Error: authentication failed", "auth_error", "pause"],
    ])("matches a decorated OpenCode error: %s", (pane, type, action) => {
      expect(match(pane)).toMatchObject({ type, action });
    });

    it.each([
      "the report mentions 429 requests in prose",
      "author error in chapter 401",
      "Error: job 14290 failed",
      "⚠ request id 4012 was retried",
      "normal unauthorized access discussion",
    ])("does not act on prose or embedded status digits: %s", pane => {
      expect(match(pane)).toBeUndefined();
    });
  });

  describe("getSessionId / refreshSessionId", () => {
    // Discovery reads `opencode session list --format json` — the official
    // CLI output — via the listSessions() seam, which these tests stub with
    // fixture rows (shape verified against opencode 1.18.15: id, title,
    // updated, created, projectId, directory; global list, newest first).
    // It is asynchronous and single-flight (#1160): refreshSessionId() looks, getSessionId() only reads.
    type Row = { id: string; directory: string; created?: number; updated?: number; parentID?: string };
    function stubSessions(backend: OpenCodeBackend, rows: Row[] | null): { calls: () => number } {
      let calls = 0;
      (backend as unknown as { listSessions: () => Promise<Row[] | null> }).listSessions = async () => { calls++; return rows; };
      return { calls: () => calls };
    }
    /** A listing the test releases by hand, to hold a discovery in flight. */
    function gatedSessions(backend: OpenCodeBackend, rows: () => Row[] | null) {
      const gates: Array<() => void> = [];
      let calls = 0;
      (backend as unknown as { listSessions: () => Promise<Row[] | null> }).listSessions = () => {
        calls++;
        return new Promise<Row[] | null>(resolve => gates.push(() => resolve(rows())));
      };
      return { calls: () => calls, release: (n = 0) => gates[n]!() };
    }
    async function discover(backend: OpenCodeBackend, rows: Row[] | null): Promise<string | null> {
      stubSessions(backend, rows);
      await backend.refreshSessionId();
      return backend.getSessionId();
    }

    it("falls back to the persisted session-id file before any spawn", () => {
      writeFileSync(join(TEST_DIR, "session-id"), "ses_persisted\n");
      const backend = new OpenCodeBackend(TEST_DIR);
      expect(backend.getSessionId()).toBe("ses_persisted");
    });

    it("returns null with no spawn and no persisted file", () => {
      const backend = new OpenCodeBackend(TEST_DIR);
      expect(backend.getSessionId()).toBeNull();
    });

    it("discovers the session created in our cwd after spawn", async () => {
      const backend = new OpenCodeBackend(TEST_DIR);
      backend.buildCommand(makeConfig());
      expect(await discover(backend, [
        { id: "ses_other_dir", directory: "/somewhere/else", created: Date.now() + 1000, updated: Date.now() + 3000 },
        { id: "ses_ours", directory: WORK_DIR, created: Date.now() + 1000, updated: Date.now() + 2000 },
      ])).toBe("ses_ours");
    });

    it("checkpoints a lazily-created session on the first idle edge", async () => {
      const backend = new OpenCodeBackend(TEST_DIR);
      backend.buildCommand(makeConfig());
      stubSessions(backend, [
        { id: "ses_runtime", directory: WORK_DIR, created: Date.now() + 1000, updated: Date.now() + 2000 },
      ]);
      const daemon = new Daemon("test-oc", {
        working_directory: WORK_DIR,
        restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
        context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
        log_level: "silent",
      } as any, TEST_DIR, false, backend, undefined, rootLogger) as Daemon & Record<string, any>;

      daemon["instanceState"] = "working";
      const now = Date.now();
      daemon["applyInstanceStateSnapshot"]({
        state: "idle",
        unchangedForMs: 0,
        observedAt: now,
        stateChangedAt: now,
      });

      // The lookup runs in the background now: the checkpoint lands when it finishes.
      await vi.waitFor(() => expect(readFileSync(join(TEST_DIR, "session-id"), "utf-8")).toBe("ses_runtime"));
    });

    it("never adopts a session created before our spawn (hijack guard)", async () => {
      const backend = new OpenCodeBackend(TEST_DIR);
      backend.buildCommand(makeConfig());
      expect(await discover(backend, [
        { id: "ses_manual_older", directory: WORK_DIR, created: Date.now() - 60_000, updated: Date.now() + 5000 },
      ])).toBeNull();
    });

    it("accepts the exact session we resumed with despite its old creation time", async () => {
      writeFileSync(join(TEST_DIR, "session-id"), "ses_resumed");
      const backend = new OpenCodeBackend(TEST_DIR);
      const cmd = backend.buildCommand(makeConfig());
      expect(cmd).toContain("--session ses_resumed");
      rmSync(join(TEST_DIR, "session-id"));                      // so only the DISCOVERY can answer (the persisted id would hide a broken guard)
      expect(await discover(backend, [
        { id: "ses_resumed", directory: WORK_DIR, created: Date.now() - 60_000, updated: Date.now() + 1000 },
      ])).toBe("ses_resumed");
    });

    it("ignores subagent child sessions", async () => {
      const backend = new OpenCodeBackend(TEST_DIR);
      backend.buildCommand(makeConfig());
      expect(await discover(backend, [
        { id: "ses_child", directory: WORK_DIR, parentID: "ses_parent", created: Date.now() + 1000, updated: Date.now() + 5000 },
      ])).toBeNull();
    });

    it("prefers the most recently updated qualifying session (post-/new tracking)", async () => {
      const backend = new OpenCodeBackend(TEST_DIR);
      backend.buildCommand(makeConfig());
      // Deliberately NOT newest-first: discovery must sort, not trust CLI order.
      expect(await discover(backend, [
        { id: "ses_first", directory: WORK_DIR, created: Date.now() + 1000, updated: Date.now() + 2000 },
        { id: "ses_second", directory: WORK_DIR, created: Date.now() + 3000, updated: Date.now() + 4000 },
      ])).toBe("ses_second");
    });

    it("returns null when the CLI listing fails", async () => {
      const backend = new OpenCodeBackend(TEST_DIR);
      backend.buildCommand(makeConfig());
      expect(await discover(backend, null)).toBeNull();
    });

    // ── #1160: never on the synchronous path ──

    it("getSessionId() never asks the CLI: it answers from the last discovery, or the persisted id", async () => {
      writeFileSync(join(TEST_DIR, "session-id"), "ses_persisted");
      const backend = new OpenCodeBackend(TEST_DIR);
      backend.buildCommand(makeConfig());
      const listing = stubSessions(backend, [{ id: "ses_ours", directory: WORK_DIR, created: Date.now() + 1000, updated: Date.now() + 2000 }]);
      for (let i = 0; i < 50; i++) backend.getSessionId();
      expect(listing.calls()).toBe(0);                         // not even once
      expect(backend.getSessionId()).toBe("ses_persisted");    // nothing discovered yet
      await backend.refreshSessionId();
      expect(backend.getSessionId()).toBe("ses_ours");
      expect(listing.calls()).toBe(1);
    });

    it("refreshSessionId() resolves to what getSessionId() now answers", async () => {
      const backend = new OpenCodeBackend(TEST_DIR);
      backend.buildCommand(makeConfig());
      stubSessions(backend, [{ id: "ses_ours", directory: WORK_DIR, created: Date.now() + 1000 }]);
      expect(await backend.refreshSessionId()).toBe("ses_ours");
    });

    it("before any spawn there is nothing to discover: the persisted id, and no CLI run", async () => {
      writeFileSync(join(TEST_DIR, "session-id"), "ses_persisted");
      const backend = new OpenCodeBackend(TEST_DIR);
      const listing = stubSessions(backend, []);
      expect(await backend.refreshSessionId()).toBe("ses_persisted");
      expect(listing.calls()).toBe(0);
    });

    // ── single flight ──

    it("concurrent refreshes share ONE CLI run and one promise", async () => {
      const backend = new OpenCodeBackend(TEST_DIR);
      backend.buildCommand(makeConfig());
      const listing = gatedSessions(backend, () => [{ id: "ses_ours", directory: WORK_DIR, created: Date.now() + 1000 }]);
      const first = backend.refreshSessionId();
      const second = backend.refreshSessionId();
      const third = backend.refreshSessionId();
      expect(second).toBe(first);
      expect(third).toBe(first);
      expect(listing.calls()).toBe(1);
      listing.release();
      expect(await Promise.all([first, second, third])).toEqual(["ses_ours", "ses_ours", "ses_ours"]);
      expect(listing.calls()).toBe(1);
    });

    it("once a discovery has finished the next refresh runs the CLI again", async () => {
      const backend = new OpenCodeBackend(TEST_DIR);
      backend.buildCommand(makeConfig());
      const listing = stubSessions(backend, [{ id: "ses_a", directory: WORK_DIR, created: Date.now() + 1000, updated: 1 }]);
      await backend.refreshSessionId();
      await backend.refreshSessionId();
      expect(listing.calls()).toBe(2);
    });

    it("a failed or throwing listing resolves quietly and does not wedge the single flight", async () => {
      const backend = new OpenCodeBackend(TEST_DIR);
      backend.buildCommand(makeConfig());
      let attempt = 0;
      (backend as unknown as { listSessions: () => Promise<unknown> }).listSessions = async () => {
        if (attempt++ === 0) throw new Error("spawn EAGAIN");
        return [{ id: "ses_ours", directory: WORK_DIR, created: Date.now() + 1000 }];
      };
      await expect(backend.refreshSessionId()).resolves.toBeNull();
      await expect(backend.refreshSessionId()).resolves.toBe("ses_ours");
    });

    // ── launch-generation fence: the hijack guard survives asynchrony ──

    it("a discovery that finishes after a NEWER launch is discarded — it was judged against the old launch", async () => {
      const backend = new OpenCodeBackend(TEST_DIR);
      backend.buildCommand(makeConfig());                       // launch 1
      const old = Date.now();
      const listing = gatedSessions(backend, () => [{ id: "ses_launch1", directory: WORK_DIR, created: old + 1, updated: old + 2 }]);
      const inFlight = backend.refreshSessionId();
      backend.buildCommand(makeConfig());                       // launch 2 while the CLI is still listing
      listing.release();
      expect(await inFlight).toBeNull();                        // not adopted for launch 2…
      expect(backend.getSessionId()).toBeNull();                // …and not cached
    });

    it("…and the same rows are still refused for the new launch when they predate it (no hijack through the fence)", async () => {
      const backend = new OpenCodeBackend(TEST_DIR);
      backend.buildCommand(makeConfig());
      const created = Date.now() - 10;
      await new Promise(resolve => setTimeout(resolve, 15));
      backend.buildCommand(makeConfig());                       // launch 2 starts AFTER the row was created
      expect(await discover(backend, [{ id: "ses_manual", directory: WORK_DIR, created, updated: created + 1 }])).toBeNull();
    });

    it("a stale in-flight discovery does not block the new launch's own", async () => {
      const backend = new OpenCodeBackend(TEST_DIR);
      backend.buildCommand(makeConfig());
      const listing = gatedSessions(backend, () => [{ id: "ses_new", directory: WORK_DIR, created: Date.now() + 5_000, updated: Date.now() + 6_000 }]);
      const stale = backend.refreshSessionId();
      backend.buildCommand(makeConfig());
      const fresh = backend.refreshSessionId();
      expect(fresh).not.toBe(stale);
      expect(listing.calls()).toBe(2);
      listing.release(1);
      expect(await fresh).toBe("ses_new");
      listing.release(0);
      await stale;
      expect(backend.getSessionId()).toBe("ses_new");           // the late stale result changes nothing
    });

    it("a new launch forgets the previous launch's discovery (falls back to the persisted id)", async () => {
      writeFileSync(join(TEST_DIR, "session-id"), "ses_persisted");
      const backend = new OpenCodeBackend(TEST_DIR);
      backend.buildCommand(makeConfig());
      expect(await discover(backend, [{ id: "ses_launch1", directory: WORK_DIR, created: Date.now() + 1000 }])).toBe("ses_launch1");
      backend.buildCommand(makeConfig());
      expect(backend.getSessionId()).toBe("ses_persisted");
    });
  });

  describe("cleanup", () => {
    it("removes instructions entry and deletes instructions file", () => {
      const backend = new OpenCodeBackend(TEST_DIR);
      backend.writeConfig(makeConfig({ instructions: "# Fleet" }));
      const instrFile = join(TEST_DIR, "fleet-instructions.md");
      expect(existsSync(instrFile)).toBe(true);
      backend.cleanup(makeConfig());
      const oc = JSON.parse(readFileSync(join(WORK_DIR, "opencode.json"), "utf-8"));
      expect(oc.instructions).not.toContain(instrFile);
      expect(existsSync(instrFile)).toBe(false);
    });

    it("preserves other instructions entries", () => {
      writeFileSync(join(WORK_DIR, "opencode.json"), JSON.stringify({ instructions: ["/keep/this.md"] }));
      const backend = new OpenCodeBackend(TEST_DIR);
      backend.writeConfig(makeConfig({ instructions: "# Fleet" }));
      backend.cleanup(makeConfig());
      const oc = JSON.parse(readFileSync(join(WORK_DIR, "opencode.json"), "utf-8"));
      expect(oc.instructions).toContain("/keep/this.md");
    });
  });
});
