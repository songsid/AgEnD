import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { OpenCodeBackend } from "../../src/backend/opencode.js";
import type { CliBackendConfig } from "../../src/backend/types.js";
import { Daemon } from "../../src/daemon.js";
import pino from "pino";
import type { Logger } from "../../src/logger.js";

const TEST_DIR = "/tmp/ccd-test-opencode-backend";
const WORK_DIR = "/tmp/ccd-test-opencode-workdir";
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

  describe("getSessionId", () => {
    const sqlite = (process as { getBuiltinModule?: (id: string) => unknown })
      .getBuiltinModule?.("node:sqlite") as
      | { DatabaseSync: new (path: string, opts?: { readOnly?: boolean }) => {
          exec(sql: string): void;
          prepare(sql: string): { run(...params: unknown[]): unknown };
          close(): void;
        } }
      | undefined;
    const DATA_HOME = join(TEST_DIR, "xdg-data");
    let savedXdg: string | undefined;

    function seedDb(rows: Array<{ id: string; directory: string; parentId?: string | null; created: number; updated: number }>): void {
      mkdirSync(join(DATA_HOME, "opencode"), { recursive: true });
      const db = new sqlite!.DatabaseSync(join(DATA_HOME, "opencode", "opencode.db"));
      db.exec("CREATE TABLE IF NOT EXISTS session (id TEXT PRIMARY KEY, directory TEXT NOT NULL, parent_id TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL)");
      const insert = db.prepare("INSERT INTO session (id, directory, parent_id, time_created, time_updated) VALUES (?, ?, ?, ?, ?)");
      for (const r of rows) insert.run(r.id, r.directory, r.parentId ?? null, r.created, r.updated);
      db.close();
    }

    beforeEach(() => {
      savedXdg = process.env.XDG_DATA_HOME;
      process.env.XDG_DATA_HOME = DATA_HOME;
    });
    afterEach(() => {
      if (savedXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = savedXdg;
    });

    it("falls back to the persisted session-id file before any spawn", () => {
      writeFileSync(join(TEST_DIR, "session-id"), "ses_persisted\n");
      const backend = new OpenCodeBackend(TEST_DIR);
      expect(backend.getSessionId()).toBe("ses_persisted");
    });

    it("returns null with no spawn and no persisted file", () => {
      const backend = new OpenCodeBackend(TEST_DIR);
      expect(backend.getSessionId()).toBeNull();
    });

    it.skipIf(!sqlite)("discovers the session created in our cwd after spawn", () => {
      const backend = new OpenCodeBackend(TEST_DIR);
      backend.buildCommand(makeConfig());
      seedDb([
        { id: "ses_ours", directory: WORK_DIR, created: Date.now() + 1000, updated: Date.now() + 2000 },
        { id: "ses_other_dir", directory: "/somewhere/else", created: Date.now() + 1000, updated: Date.now() + 3000 },
      ]);
      expect(backend.getSessionId()).toBe("ses_ours");
    });

    it.skipIf(!sqlite)("checkpoints a lazily-created session on the first idle edge", () => {
      const backend = new OpenCodeBackend(TEST_DIR);
      backend.buildCommand(makeConfig());
      seedDb([
        { id: "ses_runtime", directory: WORK_DIR, created: Date.now() + 1000, updated: Date.now() + 2000 },
      ]);
      const daemon = new Daemon("test-oc", {
        working_directory: WORK_DIR,
        restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
        context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
        log_level: "silent",
      } as any, TEST_DIR, false, backend, undefined, rootLogger) as Daemon & Record<string, any>;

      daemon.instanceState = "working";
      const now = Date.now();
      daemon.applyInstanceStateSnapshot({
        state: "idle",
        unchangedForMs: 0,
        observedAt: now,
        stateChangedAt: now,
      });

      expect(readFileSync(join(TEST_DIR, "session-id"), "utf-8")).toBe("ses_runtime");
    });

    it.skipIf(!sqlite)("never adopts a session created before our spawn (hijack guard)", () => {
      const backend = new OpenCodeBackend(TEST_DIR);
      backend.buildCommand(makeConfig());
      seedDb([
        { id: "ses_manual_older", directory: WORK_DIR, created: Date.now() - 60_000, updated: Date.now() + 5000 },
      ]);
      expect(backend.getSessionId()).toBeNull();
    });

    it.skipIf(!sqlite)("accepts the exact session we resumed with despite its old creation time", () => {
      writeFileSync(join(TEST_DIR, "session-id"), "ses_resumed");
      const backend = new OpenCodeBackend(TEST_DIR);
      const cmd = backend.buildCommand(makeConfig());
      expect(cmd).toContain("--session ses_resumed");
      seedDb([
        { id: "ses_resumed", directory: WORK_DIR, created: Date.now() - 60_000, updated: Date.now() + 1000 },
      ]);
      expect(backend.getSessionId()).toBe("ses_resumed");
    });

    it.skipIf(!sqlite)("ignores subagent child sessions", () => {
      const backend = new OpenCodeBackend(TEST_DIR);
      backend.buildCommand(makeConfig());
      seedDb([
        { id: "ses_child", directory: WORK_DIR, parentId: "ses_parent", created: Date.now() + 1000, updated: Date.now() + 5000 },
      ]);
      expect(backend.getSessionId()).toBeNull();
    });

    it.skipIf(!sqlite)("prefers the most recently updated qualifying session (post-/new tracking)", () => {
      const backend = new OpenCodeBackend(TEST_DIR);
      backend.buildCommand(makeConfig());
      seedDb([
        { id: "ses_first", directory: WORK_DIR, created: Date.now() + 1000, updated: Date.now() + 2000 },
        { id: "ses_second", directory: WORK_DIR, created: Date.now() + 3000, updated: Date.now() + 4000 },
      ]);
      expect(backend.getSessionId()).toBe("ses_second");
    });

    it.skipIf(!sqlite)("returns null when the DB does not exist", () => {
      const backend = new OpenCodeBackend(TEST_DIR);
      backend.buildCommand(makeConfig());
      expect(backend.getSessionId()).toBeNull();
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
