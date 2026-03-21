# Multi-Channel Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the official Telegram plugin with a self-built channel abstraction layer, support multiple channel adapters per instance, and add fleet management for running multiple daemon instances.

**Architecture:** Daemon embeds an MCP channel server exposed as a local plugin via `--plugin-dir`. Channel adapters (Telegram first) communicate with the MCP server through a Unix socket IPC bridge. A MessageBus merges inbound messages and routes outbound, including approval races. Fleet manager spawns/monitors N daemon instances from a single `fleet.yaml`.

**Tech Stack:** TypeScript, Node.js 20+, `@modelcontextprotocol/sdk`, `grammy`, `node-pty`, `better-sqlite3`, `vitest`

**Spec:** `docs/superpowers/specs/2026-03-21-multi-channel-architecture-design.md`

---

## File Map

### New Files

| File | Responsibility |
|------|---------------|
| `src/channel/types.ts` | ChannelAdapter interface, InboundMessage, Attachment, SendOpts, SentMessage, OutboundMessage, ApprovalHandle, Target, ApprovalResponse |
| `src/channel/access-manager.ts` | Pairing/locked state machine, code generation/validation, allowlist persistence |
| `src/channel/adapters/telegram.ts` | TelegramAdapter: Grammy bot, polling, message handling, approval buttons, file download |
| `src/channel/message-bus.ts` | MessageBus: adapter registry, inbound merge, outbound routing, approval race with AbortController |
| `src/channel/ipc-bridge.ts` | Unix socket server (daemon side) + client (MCP server side) for bidirectional JSON messaging |
| `src/channel/mcp-server.ts` | MCP channel server entry point: reply/react/edit/download tools, channel message push via IPC |
| `src/daemon-entry.ts` | Thin CLI entry point for fleet-forked daemon child processes (parses args, instantiates Daemon) |
| `src/approval/approval-server.ts` | HTTP server for PreToolUse hook, calls messageBus.requestApproval() |
| `src/approval/pty-detector.ts` | PTY prompt pattern detection, extracted from cli.ts, calls messageBus.requestApproval() |
| `src/daemon.ts` | Single-instance orchestrator: wires up all components, manages lifecycle |
| `src/fleet-manager.ts` | Fleet start/stop/status, spawn/monitor child processes, port allocation |
| `src/plugin/ccd-channel/.claude-plugin/plugin.json` | Local plugin manifest |
| `src/plugin/ccd-channel/.mcp.json` | MCP server definition for local plugin |
| `tests/channel/access-manager.test.ts` | AccessManager unit tests |
| `tests/channel/message-bus.test.ts` | MessageBus unit tests |
| `tests/channel/ipc-bridge.test.ts` | IPC bridge unit tests |
| `tests/channel/adapters/telegram.test.ts` | TelegramAdapter unit tests |
| `tests/approval/approval-server.test.ts` | Approval server unit tests |
| `tests/approval/pty-detector.test.ts` | PTY detector unit tests |
| `tests/daemon.test.ts` | Daemon orchestrator tests |
| `tests/fleet-manager.test.ts` | Fleet manager tests |

### Modified Files

| File | Change |
|------|--------|
| `src/types.ts` | Add FleetConfig, InstanceConfig, ChannelConfig, AccessConfig; keep DaemonConfig for backward compat |
| `src/config.ts` | Add `loadFleetConfig()`, update `deepMerge` to handle new types, array-replace semantics for `channels` |
| `src/process-manager.ts` | Accept instance-scoped paths (dataDir param), use `--plugin-dir` + `--channels plugin:ccd-channel`, update tool allow-list |
| `src/context-guardian.ts` | Already accepts statusFilePath — minor: ensure it works with instance-scoped paths |
| `src/cli.ts` | Add `fleet` and `access` command groups, refactor `start` to delegate to daemon.ts |
| `src/service-installer.ts` | Support `fleet install` (single service for fleet) |
| `package.json` | Add `@modelcontextprotocol/sdk`, `grammy` dependencies |
| `tests/config.test.ts` | Add tests for `loadFleetConfig()` and array-replace merge |
| `tests/process-manager.test.ts` | Update for new constructor signature |

**Import path convention:** Tests in `tests/channel/` import from `../../src/channel/...`, tests in `tests/channel/adapters/` import from `../../../src/channel/...`, tests in `tests/approval/` import from `../../src/approval/...`. All test imports in this plan follow this convention.

**Note on `ccd fleet install`:** Service installation for fleet mode reuses the existing `service-installer.ts` with minor changes (command becomes `ccd fleet start`). This is a small addition in Task 12 Step 4, not a separate task.

---

## Task 1: Global Types + Config Foundation

**Files:**
- Modify: `src/types.ts`
- Modify: `src/config.ts`
- Modify: `tests/config.test.ts`

- [ ] **Step 1: Write failing test for FleetConfig loading**

```typescript
// tests/config.test.ts — add to existing file
describe("loadFleetConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ccd-fleet-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads fleet.yaml with defaults merged into instances", () => {
    const configPath = join(tmpDir, "fleet.yaml");
    writeFileSync(configPath, `
defaults:
  restart_policy:
    max_retries: 5
    backoff: exponential
    reset_after: 300
  log_level: info

instances:
  project-a:
    working_directory: /tmp/project-a
    channels:
      - type: telegram
        bot_token_env: BOT_A
        access:
          mode: pairing
          allowed_users: [123]
    context_guardian:
      threshold_percentage: 60
      max_age_hours: 2
      strategy: hybrid
`);
    const fleet = loadFleetConfig(configPath);
    expect(fleet.instances["project-a"].restart_policy.max_retries).toBe(5);
    expect(fleet.instances["project-a"].context_guardian.threshold_percentage).toBe(60);
    expect(fleet.instances["project-a"].channels).toHaveLength(1);
    expect(fleet.instances["project-a"].channels[0].type).toBe("telegram");
  });

  it("channels array is replaced, not merged", () => {
    const configPath = join(tmpDir, "fleet.yaml");
    writeFileSync(configPath, `
defaults:
  channels:
    - type: telegram
      bot_token_env: DEFAULT_BOT
      access:
        mode: locked
        allowed_users: []

instances:
  proj:
    working_directory: /tmp/proj
    channels:
      - type: telegram
        bot_token_env: PROJ_BOT
        access:
          mode: pairing
          allowed_users: [456]
`);
    const fleet = loadFleetConfig(configPath);
    expect(fleet.instances.proj.channels).toHaveLength(1);
    expect(fleet.instances.proj.channels[0].bot_token_env).toBe("PROJ_BOT");
  });

  it("returns empty instances when no fleet.yaml exists", () => {
    const fleet = loadFleetConfig(join(tmpDir, "nonexistent.yaml"));
    expect(fleet.instances).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — `loadFleetConfig` not found

- [ ] **Step 3: Add new types to src/types.ts**

Add these types after the existing `DaemonConfig`:

```typescript
export interface AccessConfig {
  mode: "pairing" | "locked";
  allowed_users: number[];
  max_pending_codes: number;
  code_expiry_minutes: number;
}

export interface ChannelConfig {
  type: "telegram";
  bot_token_env: string;
  access: AccessConfig;
  options?: Record<string, unknown>;
}

export interface InstanceConfig {
  working_directory: string;
  channels: ChannelConfig[];
  restart_policy: DaemonConfig["restart_policy"];
  context_guardian: DaemonConfig["context_guardian"];
  memory: DaemonConfig["memory"];
  memory_directory?: string;
  log_level: DaemonConfig["log_level"];
  approval_port?: number;
  /** @deprecated backward compat with old config.yaml */
  channel_plugin?: string;
}

export interface FleetConfig {
  defaults: Partial<InstanceConfig>;
  instances: Record<string, InstanceConfig>;
}
```

- [ ] **Step 4: Implement loadFleetConfig in src/config.ts**

```typescript
export const DEFAULT_INSTANCE_CONFIG: Omit<InstanceConfig, "working_directory" | "channels"> = {
  restart_policy: DEFAULT_CONFIG.restart_policy,
  context_guardian: DEFAULT_CONFIG.context_guardian,
  memory: DEFAULT_CONFIG.memory,
  log_level: DEFAULT_CONFIG.log_level,
};

export function loadFleetConfig(configPath: string): FleetConfig {
  if (!existsSync(configPath)) {
    return { defaults: {}, instances: {} };
  }
  const raw = readFileSync(configPath, "utf-8");
  const parsed = yaml.load(raw) as { defaults?: Partial<InstanceConfig>; instances?: Record<string, Partial<InstanceConfig>> } | null;
  if (!parsed?.instances) {
    return { defaults: parsed?.defaults ?? {}, instances: {} };
  }

  const defaults = parsed.defaults ?? {};
  const instances: Record<string, InstanceConfig> = {};

  for (const [name, partial] of Object.entries(parsed.instances)) {
    // Start with hardcoded defaults, merge fleet defaults, then instance overrides
    // channels arrays are replaced, not merged
    const base = deepMergeGeneric(DEFAULT_INSTANCE_CONFIG, defaults);
    const merged = deepMergeGeneric(base, partial);
    instances[name] = merged as InstanceConfig;
  }

  // Validate required fields
  for (const [name, inst] of Object.entries(instances)) {
    if (!inst.working_directory) {
      throw new Error(`Instance "${name}" missing required field: working_directory`);
    }
    if (!inst.channels?.length) {
      throw new Error(`Instance "${name}" must have at least one channel`);
    }
  }

  return { defaults, instances };
}
```

Update `deepMerge` to be generic (`deepMergeGeneric`) — arrays are replaced, objects are deep-merged:

```typescript
function deepMergeGeneric<T extends Record<string, unknown>>(
  target: T,
  source: Partial<T>,
): T {
  const result = { ...target } as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    const sourceVal = (source as Record<string, unknown>)[key];
    const targetVal = result[key];
    if (
      sourceVal !== null &&
      typeof sourceVal === "object" &&
      !Array.isArray(sourceVal) &&
      typeof targetVal === "object" &&
      targetVal !== null &&
      !Array.isArray(targetVal)
    ) {
      result[key] = deepMergeGeneric(
        targetVal as Record<string, unknown>,
        sourceVal as Record<string, unknown>,
      );
    } else if (sourceVal !== undefined) {
      result[key] = sourceVal;
    }
  }
  return result as T;
}
```

Keep the old `deepMerge` as a thin wrapper for backward compat, or replace it with `deepMergeGeneric`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/config.test.ts`
Expected: ALL PASS (both old and new tests)

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/config.ts tests/config.test.ts
git commit -m "feat: add FleetConfig types and loadFleetConfig"
```

---

## Task 2: Channel Abstraction Types

**Files:**
- Create: `src/channel/types.ts`

- [ ] **Step 1: Create channel types file**

```typescript
// src/channel/types.ts
import { EventEmitter } from "node:events";

export interface ChannelAdapter extends EventEmitter {
  readonly type: string;
  readonly id: string;

  start(): Promise<void>;
  stop(): Promise<void>;

  sendText(chatId: string, text: string, opts?: SendOpts): Promise<SentMessage>;
  sendFile(chatId: string, filePath: string): Promise<SentMessage>;
  editMessage(chatId: string, messageId: string, text: string): Promise<void>;
  react(chatId: string, messageId: string, emoji: string): Promise<void>;

  // Adapter resolves which chat(s) to send to internally (all allowed users)
  sendApproval(
    prompt: string,
    callback: (decision: "approve" | "deny") => void,
    signal?: AbortSignal,
  ): ApprovalHandle;

  downloadAttachment(fileId: string): Promise<string>;

  handlePairing(chatId: string, userId: string): Promise<string>;
  confirmPairing(code: string): Promise<boolean>;
}

export interface ApprovalHandle {
  cancel(): void;
}

export interface SendOpts {
  replyTo?: string;
  format?: "text" | "markdown";
  chunkLimit?: number;
}

export interface SentMessage {
  messageId: string;
  chatId: string;
}

export interface OutboundMessage {
  text?: string;
  filePath?: string;
  replyTo?: string;
  format?: "text" | "markdown";
}

export interface InboundMessage {
  source: string;
  adapterId: string;
  chatId: string;
  messageId: string;
  userId: string;
  username: string;
  text: string;
  timestamp: Date;
  attachments?: Attachment[];
  replyTo?: string;
}

export interface Attachment {
  kind: "photo" | "document" | "audio" | "voice" | "video" | "sticker";
  fileId: string;
  localPath?: string;
  mime?: string;
  size?: number;
  filename?: string;
  transcription?: string;
}

export interface ApprovalResponse {
  decision: "approve" | "deny";
  respondedBy: { channelType: string; userId: string };
}

export interface Target {
  adapterId?: string;
  chatId: string;
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/channel/types.ts
git commit -m "feat: add channel abstraction type definitions"
```

---

## Task 3: Access Manager

**Files:**
- Create: `src/channel/access-manager.ts`
- Create: `tests/channel/access-manager.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/channel/access-manager.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AccessManager } from "../src/channel/access-manager.js";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

describe("AccessManager", () => {
  let tmpDir: string;
  let am: AccessManager;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ccd-access-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    am = new AccessManager({
      mode: "pairing",
      allowed_users: [111],
      max_pending_codes: 3,
      code_expiry_minutes: 60,
    }, join(tmpDir, "access.json"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("allows known users", () => {
    expect(am.isAllowed(111)).toBe(true);
  });

  it("rejects unknown users in locked mode", () => {
    am.setMode("locked");
    expect(am.isAllowed(999)).toBe(false);
  });

  it("generates pairing code for unknown users", () => {
    const code = am.generateCode(999);
    expect(code).toMatch(/^[0-9A-F]{6}$/);
  });

  it("confirms valid pairing code", () => {
    const code = am.generateCode(999);
    const result = am.confirmCode(code);
    expect(result).toBe(true);
    expect(am.isAllowed(999)).toBe(true);
  });

  it("rejects invalid pairing code", () => {
    expect(am.confirmCode("ZZZZZZ")).toBe(false);
  });

  it("limits pending codes", () => {
    am.generateCode(100);
    am.generateCode(200);
    am.generateCode(300);
    expect(() => am.generateCode(400)).toThrow(/max pending/i);
  });

  it("limits pairing replies per sender", () => {
    am.generateCode(999);
    am.generateCode(999); // 2nd attempt, same user — allowed (replaces)
    // After 2 generateCode calls for same unknown user, hasPairingQuota returns false
    expect(am.hasPairingQuota(999)).toBe(false);
  });

  it("persists state to file", () => {
    am.generateCode(999);
    const code = am.generateCode(999);
    am.confirmCode(code);
    // Load from same file
    const am2 = new AccessManager({
      mode: "pairing",
      allowed_users: [111],
      max_pending_codes: 3,
      code_expiry_minutes: 60,
    }, join(tmpDir, "access.json"));
    expect(am2.isAllowed(999)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/channel/access-manager.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement AccessManager**

```typescript
// src/channel/access-manager.ts
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { AccessConfig } from "../types.js";

interface PendingCode {
  code: string;
  userId: number;
  createdAt: number;
  attempts: number;
}

interface AccessState {
  mode?: "pairing" | "locked";
  allowed_users: number[];
  pending_codes: PendingCode[];
}

export class AccessManager {
  private state: AccessState;
  private config: AccessConfig;
  private statePath: string;

  constructor(config: AccessConfig, statePath: string) {
    this.config = { ...config };
    this.statePath = statePath;
    this.state = this.loadState();
  }

  isAllowed(userId: number): boolean {
    return this.state.allowed_users.includes(userId);
  }

  hasPairingQuota(userId: number): boolean {
    if (this.config.mode !== "pairing") return false;
    const existing = this.state.pending_codes.filter(p => p.userId === userId);
    return existing.length < 2;
  }

  generateCode(userId: number): string {
    this.pruneExpired();
    if (this.config.mode !== "pairing") {
      throw new Error("Cannot generate pairing code in locked mode");
    }
    // Check per-user quota (max 2 attempts)
    const userCodes = this.state.pending_codes.filter(p => p.userId === userId);
    if (userCodes.length >= 2) {
      throw new Error("Max pairing attempts reached for this user");
    }
    // Check global pending limit
    const uniqueUsers = new Set(this.state.pending_codes.map(p => p.userId));
    if (!uniqueUsers.has(userId) && uniqueUsers.size >= this.config.max_pending_codes) {
      throw new Error("Max pending pairing codes reached");
    }

    const code = randomBytes(3).toString("hex").toUpperCase();
    this.state.pending_codes.push({
      code,
      userId,
      createdAt: Date.now(),
      attempts: userCodes.length + 1,
    });
    this.saveState();
    return code;
  }

  confirmCode(code: string): boolean {
    this.pruneExpired();
    const idx = this.state.pending_codes.findIndex(p => p.code === code.toUpperCase());
    if (idx === -1) return false;

    const pending = this.state.pending_codes[idx];
    this.state.pending_codes.splice(idx, 1);
    // Remove any other pending codes for this user
    this.state.pending_codes = this.state.pending_codes.filter(p => p.userId !== pending.userId);

    if (!this.state.allowed_users.includes(pending.userId)) {
      this.state.allowed_users.push(pending.userId);
    }
    this.saveState();
    return true;
  }

  setMode(mode: "pairing" | "locked"): void {
    this.config.mode = mode;
    this.state.mode = mode;
    this.saveState();
  }

  getMode(): "pairing" | "locked" {
    return this.config.mode;
  }

  getAllowedUsers(): number[] {
    return [...this.state.allowed_users];
  }

  removeUser(userId: number): boolean {
    const idx = this.state.allowed_users.indexOf(userId);
    if (idx === -1) return false;
    this.state.allowed_users.splice(idx, 1);
    this.saveState();
    return true;
  }

  private pruneExpired(): void {
    const expiryMs = this.config.code_expiry_minutes * 60 * 1000;
    const now = Date.now();
    this.state.pending_codes = this.state.pending_codes.filter(
      p => now - p.createdAt < expiryMs,
    );
  }

  private loadState(): AccessState {
    if (existsSync(this.statePath)) {
      try {
        const data = JSON.parse(readFileSync(this.statePath, "utf-8"));
        if (data.mode) this.config.mode = data.mode;
        return {
          mode: data.mode ?? this.config.mode,
          allowed_users: [...new Set([...this.config.allowed_users, ...(data.allowed_users ?? [])])],
          pending_codes: data.pending_codes ?? [],
        };
      } catch {
        // Corrupt file — start fresh
      }
    }
    return {
      allowed_users: [...this.config.allowed_users],
      pending_codes: [],
    };
  }

  private saveState(): void {
    writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/channel/access-manager.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/channel/access-manager.ts tests/channel/access-manager.test.ts
git commit -m "feat: add AccessManager with pairing/locked state machine"
```

---

## Task 4: IPC Bridge

**Files:**
- Create: `src/channel/ipc-bridge.ts`
- Create: `tests/channel/ipc-bridge.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/channel/ipc-bridge.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { IpcServer, IpcClient } from "../src/channel/ipc-bridge.js";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

describe("IPC Bridge", () => {
  let tmpDir: string;
  let server: IpcServer;
  let client: IpcClient;

  afterEach(async () => {
    await client?.close();
    await server?.close();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("sends messages from server to client", async () => {
    tmpDir = join(tmpdir(), `ccd-ipc-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    const sockPath = join(tmpDir, "test.sock");

    server = new IpcServer(sockPath);
    await server.listen();

    const received: unknown[] = [];
    client = new IpcClient(sockPath);
    client.on("message", (msg) => received.push(msg));
    await client.connect();

    server.broadcast({ type: "inbound", text: "hello" });

    // Wait for message delivery
    await new Promise((r) => setTimeout(r, 100));
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ type: "inbound", text: "hello" });
  });

  it("sends messages from client to server", async () => {
    tmpDir = join(tmpdir(), `ccd-ipc-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    const sockPath = join(tmpDir, "test.sock");

    server = new IpcServer(sockPath);
    const received: unknown[] = [];
    server.on("message", (msg) => received.push(msg));
    await server.listen();

    client = new IpcClient(sockPath);
    await client.connect();
    client.send({ type: "tool_call", tool: "reply", args: { text: "hi" } });

    await new Promise((r) => setTimeout(r, 100));
    expect(received).toHaveLength(1);
    expect((received[0] as any).type).toBe("tool_call");
  });

  it("cleans up stale socket on start", async () => {
    tmpDir = join(tmpdir(), `ccd-ipc-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    const sockPath = join(tmpDir, "test.sock");

    // Create first server, then close it (leaving socket file)
    const server1 = new IpcServer(sockPath);
    await server1.listen();
    await server1.close();

    // Second server should start fine (cleans stale socket)
    server = new IpcServer(sockPath);
    await server.listen();

    client = new IpcClient(sockPath);
    await client.connect();
    // If we got here, it worked
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/channel/ipc-bridge.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement IPC Bridge**

```typescript
// src/channel/ipc-bridge.ts
import { createServer, createConnection, type Server, type Socket } from "node:net";
import { EventEmitter } from "node:events";
import { existsSync, unlinkSync } from "node:fs";

/**
 * Newline-delimited JSON over Unix domain socket.
 * Each message is a single JSON object followed by \n.
 */

export class IpcServer extends EventEmitter {
  private server: Server | null = null;
  private clients: Set<Socket> = new Set();

  constructor(private sockPath: string) {
    super();
  }

  async listen(): Promise<void> {
    // Clean up stale socket
    if (existsSync(this.sockPath)) {
      try { unlinkSync(this.sockPath); } catch {}
    }

    return new Promise((resolve, reject) => {
      this.server = createServer((socket) => {
        this.clients.add(socket);
        let buffer = "";

        socket.on("data", (data) => {
          buffer += data.toString();
          let idx: number;
          while ((idx = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            try {
              this.emit("message", JSON.parse(line), socket);
            } catch {}
          }
        });

        socket.on("close", () => {
          this.clients.delete(socket);
        });

        socket.on("error", () => {
          this.clients.delete(socket);
        });
      });

      this.server.on("error", reject);
      this.server.listen(this.sockPath, () => resolve());
    });
  }

  broadcast(msg: unknown): void {
    const line = JSON.stringify(msg) + "\n";
    for (const client of this.clients) {
      try { client.write(line); } catch {}
    }
  }

  send(socket: Socket, msg: unknown): void {
    try { socket.write(JSON.stringify(msg) + "\n"); } catch {}
  }

  async close(): Promise<void> {
    for (const client of this.clients) {
      client.destroy();
    }
    this.clients.clear();
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => {
        if (existsSync(this.sockPath)) {
          try { unlinkSync(this.sockPath); } catch {}
        }
        resolve();
      });
    });
  }
}

export class IpcClient extends EventEmitter {
  private socket: Socket | null = null;

  constructor(private sockPath: string) {
    super();
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = createConnection(this.sockPath, () => resolve());
      this.socket.on("error", reject);

      let buffer = "";
      this.socket.on("data", (data) => {
        buffer += data.toString();
        let idx: number;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          try {
            this.emit("message", JSON.parse(line));
          } catch {}
        }
      });
    });
  }

  send(msg: unknown): void {
    this.socket?.write(JSON.stringify(msg) + "\n");
  }

  async close(): Promise<void> {
    this.socket?.destroy();
    this.socket = null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/channel/ipc-bridge.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/channel/ipc-bridge.ts tests/channel/ipc-bridge.test.ts
git commit -m "feat: add Unix socket IPC bridge for daemon-MCP communication"
```

---

## Task 5: MessageBus

**Files:**
- Create: `src/channel/message-bus.ts`
- Create: `tests/channel/message-bus.test.ts`

- [ ] **Step 1: Write failing tests**

Test registration, inbound merge, outbound routing, and approval race. Use a mock adapter:

```typescript
// tests/channel/message-bus.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MessageBus } from "../src/channel/message-bus.js";
import { EventEmitter } from "node:events";
import type { ChannelAdapter, InboundMessage, ApprovalHandle } from "../src/channel/types.js";

function createMockAdapter(id: string): ChannelAdapter {
  const emitter = new EventEmitter() as ChannelAdapter;
  Object.assign(emitter, {
    type: "mock",
    id,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    sendText: vi.fn().mockResolvedValue({ messageId: "1", chatId: "c1" }),
    sendFile: vi.fn().mockResolvedValue({ messageId: "2", chatId: "c1" }),
    editMessage: vi.fn().mockResolvedValue(undefined),
    react: vi.fn().mockResolvedValue(undefined),
    sendApproval: vi.fn().mockImplementation((_prompt, callback, _signal) => {
      // Don't call callback automatically — tests will trigger it
      return { cancel: vi.fn() } as ApprovalHandle;
    }),
    downloadAttachment: vi.fn().mockResolvedValue("/tmp/file.jpg"),
    handlePairing: vi.fn().mockResolvedValue("ABC123"),
    confirmPairing: vi.fn().mockResolvedValue(true),
  });
  return emitter;
}

describe("MessageBus", () => {
  let bus: MessageBus;
  let adapter1: ChannelAdapter;
  let adapter2: ChannelAdapter;

  beforeEach(() => {
    bus = new MessageBus();
    adapter1 = createMockAdapter("a1");
    adapter2 = createMockAdapter("a2");
    bus.register(adapter1);
    bus.register(adapter2);
  });

  it("merges inbound messages from all adapters", async () => {
    const received: InboundMessage[] = [];
    bus.on("message", (msg) => received.push(msg));

    adapter1.emit("message", { source: "mock", adapterId: "a1", text: "hi from a1" } as InboundMessage);
    adapter2.emit("message", { source: "mock", adapterId: "a2", text: "hi from a2" } as InboundMessage);

    expect(received).toHaveLength(2);
  });

  it("routes outbound to specific adapter", async () => {
    await bus.send({ adapterId: "a1", chatId: "c1" }, { text: "hello" });
    expect(adapter1.sendText).toHaveBeenCalledWith("c1", "hello", undefined);
    expect(adapter2.sendText).not.toHaveBeenCalled();
  });

  it("broadcasts outbound to all adapters when no adapterId", async () => {
    await bus.send({ chatId: "c1" }, { text: "broadcast" });
    expect(adapter1.sendText).toHaveBeenCalled();
    expect(adapter2.sendText).toHaveBeenCalled();
  });

  it("approval race resolves on first response", async () => {
    // Override sendApproval to call callback immediately for adapter1
    (adapter1.sendApproval as any).mockImplementation(
      (_prompt: string, callback: (d: "approve" | "deny") => void) => {
        setTimeout(() => callback("approve"), 10);
        return { cancel: vi.fn() };
      },
    );

    const result = await bus.requestApproval("Allow this?");
    expect(result.decision).toBe("approve");
  });

  it("approval race cancels other adapters after first response", async () => {
    const cancelFn = vi.fn();
    (adapter1.sendApproval as any).mockImplementation(
      (_p: string, cb: (d: "approve" | "deny") => void) => {
        setTimeout(() => cb("approve"), 10);
        return { cancel: vi.fn() };
      },
    );
    (adapter2.sendApproval as any).mockImplementation(
      () => ({ cancel: cancelFn }),
    );

    await bus.requestApproval("Allow this?");
    expect(cancelFn).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/channel/message-bus.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement MessageBus**

```typescript
// src/channel/message-bus.ts
import { EventEmitter } from "node:events";
import type {
  ChannelAdapter, InboundMessage, OutboundMessage,
  Target, ApprovalResponse, ApprovalHandle,
} from "./types.js";

const APPROVAL_TIMEOUT_MS = 120_000;

export class MessageBus extends EventEmitter {
  private adapters: Map<string, ChannelAdapter> = new Map();

  register(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.id, adapter);
    adapter.on("message", (msg: InboundMessage) => {
      this.emit("message", msg);
    });
  }

  unregister(adapterId: string): void {
    this.adapters.delete(adapterId);
  }

  getAdapter(adapterId: string): ChannelAdapter | undefined {
    return this.adapters.get(adapterId);
  }

  getAllAdapters(): ChannelAdapter[] {
    return [...this.adapters.values()];
  }

  async send(target: Target, msg: OutboundMessage): Promise<void> {
    if (target.adapterId) {
      const adapter = this.adapters.get(target.adapterId);
      if (!adapter) throw new Error(`Adapter ${target.adapterId} not found`);
      if (msg.filePath) {
        await adapter.sendFile(target.chatId, msg.filePath);
      } else if (msg.text) {
        await adapter.sendText(target.chatId, msg.text, {
          replyTo: msg.replyTo,
          format: msg.format,
        });
      }
    } else {
      // Broadcast
      const promises = [...this.adapters.values()].map(async (adapter) => {
        if (msg.filePath) {
          await adapter.sendFile(target.chatId, msg.filePath);
        } else if (msg.text) {
          await adapter.sendText(target.chatId, msg.text, {
            replyTo: msg.replyTo,
            format: msg.format,
          });
        }
      });
      await Promise.allSettled(promises);
    }
  }

  requestApproval(prompt: string): Promise<ApprovalResponse> {
    return new Promise((resolve) => {
      const controller = new AbortController();
      const handles: ApprovalHandle[] = [];
      let resolved = false;

      const timeout = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        controller.abort();
        for (const h of handles) h.cancel();
        resolve({ decision: "deny", respondedBy: { channelType: "timeout", userId: "" } });
      }, APPROVAL_TIMEOUT_MS);

      for (const adapter of this.adapters.values()) {
        // Find first allowed user's chatId to send approval to
        // For now, send to all registered adapters — they know which chat to use
        const handle = adapter.sendApproval(
          prompt,
          (decision) => {
            if (resolved) return; // late click
            resolved = true;
            clearTimeout(timeout);
            controller.abort();
            for (const h of handles) h.cancel();
            resolve({
              decision,
              respondedBy: { channelType: adapter.type, userId: adapter.id },
            });
          },
          controller.signal,
        );
        handles.push(handle);
      }

      // Edge case: no adapters registered
      if (this.adapters.size === 0) {
        clearTimeout(timeout);
        resolve({ decision: "deny", respondedBy: { channelType: "none", userId: "" } });
      }
    });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/channel/message-bus.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/channel/message-bus.ts tests/channel/message-bus.test.ts
git commit -m "feat: add MessageBus with inbound merge, outbound routing, approval race"
```

---

## Task 6: Telegram Adapter

**Files:**
- Create: `src/channel/adapters/telegram.ts`
- Create: `tests/channel/adapters/telegram.test.ts`
- Modify: `package.json` (add `grammy`)

- [ ] **Step 1: Install grammy**

Run: `npm install grammy`

- [ ] **Step 2: Write failing tests for TelegramAdapter**

Test adapter creation, message emission, sendText chunking, approval buttons. Use Grammy's test utilities or mock the Bot class.

```typescript
// tests/channel/adapters/telegram.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// We test the adapter in isolation by mocking Grammy
vi.mock("grammy", () => {
  const EventEmitter = require("node:events").EventEmitter;
  class MockBot extends EventEmitter {
    api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
      sendDocument: vi.fn().mockResolvedValue({ message_id: 2 }),
      sendPhoto: vi.fn().mockResolvedValue({ message_id: 3 }),
      editMessageText: vi.fn().mockResolvedValue(true),
      setMessageReaction: vi.fn().mockResolvedValue(true),
      getFile: vi.fn().mockResolvedValue({ file_path: "photos/file.jpg" }),
      getMe: vi.fn().mockResolvedValue({ id: 123, username: "test_bot" }),
    };
    start = vi.fn();
    stop = vi.fn();
    on = vi.fn();
    command = vi.fn();
  }
  return { Bot: MockBot };
});

import { TelegramAdapter } from "../src/channel/adapters/telegram.js";
import { AccessManager } from "../src/channel/access-manager.js";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

describe("TelegramAdapter", () => {
  let tmpDir: string;
  let adapter: TelegramAdapter;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ccd-tg-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    adapter = new TelegramAdapter({
      id: "tg-1",
      botToken: "fake-token",
      accessManager: new AccessManager(
        { mode: "locked", allowed_users: [111], max_pending_codes: 3, code_expiry_minutes: 60 },
        join(tmpDir, "access.json"),
      ),
      inboxDir: join(tmpDir, "inbox"),
    });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("has correct type and id", () => {
    expect(adapter.type).toBe("telegram");
    expect(adapter.id).toBe("tg-1");
  });

  it("sendText calls bot API", async () => {
    await adapter.start();
    const result = await adapter.sendText("123", "hello");
    expect(result.messageId).toBeDefined();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/channel/adapters/telegram.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Implement TelegramAdapter**

Create `src/channel/adapters/telegram.ts`. This is the largest single file — implements the full ChannelAdapter interface using Grammy. Key responsibilities:
- Bot polling loop (start/stop)
- Message handler → emit InboundMessage with proper Attachment handling
- sendText with auto-chunking (4096 char limit)
- sendFile with mime-type detection (photo vs document)
- sendApproval with inline keyboard buttons + callback query handler
- downloadAttachment via Grammy file API
- handlePairing / confirmPairing delegation to AccessManager

The adapter should be ~200-300 lines. Reference the official plugin's `server.ts` (lines around message handling, approval buttons) for Telegram API patterns, but implement cleanly against the ChannelAdapter interface.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/channel/adapters/telegram.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/channel/adapters/telegram.ts tests/channel/adapters/telegram.test.ts package.json package-lock.json
git commit -m "feat: add TelegramAdapter implementing ChannelAdapter"
```

---

## Task 7: MCP Channel Server + Local Plugin

**Files:**
- Create: `src/channel/mcp-server.ts`
- Create: `src/plugin/ccd-channel/.claude-plugin/plugin.json`
- Create: `src/plugin/ccd-channel/.mcp.json`
- Modify: `package.json` (add `@modelcontextprotocol/sdk`)

- [ ] **Step 1: Install MCP SDK**

Run: `npm install @modelcontextprotocol/sdk`

- [ ] **Step 2: Create local plugin structure**

```json
// src/plugin/ccd-channel/.claude-plugin/plugin.json
{
  "name": "ccd-channel",
  "version": "0.1.0",
  "description": "Built-in channel server for claude-channel-daemon"
}
```

```json
// src/plugin/ccd-channel/.mcp.json
{
  "ccd-channel": {
    "command": "node",
    "args": ["${CLAUDE_PLUGIN_ROOT}/server.js"],
    "env": {
      "CCD_SOCKET_PATH": "${CCD_SOCKET_PATH}"
    }
  }
}
```

- [ ] **Step 3: Research MCP channel push mechanism**

Read the official telegram plugin source at `~/.claude/plugins/cache/claude-plugins-official/telegram/0.0.1/server.ts` to understand exactly how it pushes inbound messages to Claude via the MCP channel protocol. Look for:
- Which MCP SDK class is used (Server, McpServer, etc.)
- What method/notification pushes channel messages
- The message format Claude expects (`<channel source="..." ...>` tags)
- How the channel "permission" capability is declared

Document findings before writing code. If the SDK's high-level `McpServer` doesn't support channel push, use the low-level `Server` class directly.

- [ ] **Step 4: Implement MCP server entry point**

```typescript
// src/channel/mcp-server.ts
// This file runs as a separate process (spawned by Claude Code).
// It connects to the daemon via Unix socket IPC and exposes MCP tools.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { IpcClient } from "./ipc-bridge.js";
import { z } from "zod"; // comes with MCP SDK

const socketPath = process.env.CCD_SOCKET_PATH;
if (!socketPath) {
  console.error("CCD_SOCKET_PATH not set");
  process.exit(1);
}

const ipc = new IpcClient(socketPath);
const server = new McpServer({
  name: "ccd-channel",
  version: "0.1.0",
});

// Tool: reply
server.tool("reply", {
  chat_id: z.string(),
  text: z.string(),
  files: z.array(z.string()).optional(),
  reply_to: z.string().optional(),
}, async (args) => {
  // Forward to daemon via IPC
  const response = await ipcRequest({ type: "tool_call", tool: "reply", args });
  return { content: [{ type: "text", text: response.result ?? "sent" }] };
});

// Tool: react
server.tool("react", {
  chat_id: z.string(),
  message_id: z.string(),
  emoji: z.string(),
}, async (args) => {
  const response = await ipcRequest({ type: "tool_call", tool: "react", args });
  return { content: [{ type: "text", text: response.result ?? "reacted" }] };
});

// Tool: edit_message
server.tool("edit_message", {
  chat_id: z.string(),
  message_id: z.string(),
  text: z.string(),
}, async (args) => {
  const response = await ipcRequest({ type: "tool_call", tool: "edit_message", args });
  return { content: [{ type: "text", text: response.result ?? "edited" }] };
});

// Tool: download_attachment
server.tool("download_attachment", {
  file_id: z.string(),
}, async (args) => {
  const response = await ipcRequest({ type: "tool_call", tool: "download_attachment", args });
  return { content: [{ type: "text", text: response.result ?? "" }] };
});

// IPC request-response helper
let requestId = 0;
const pendingRequests = new Map<number, (response: any) => void>();

function ipcRequest(msg: unknown, timeoutMs = 30_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`IPC request ${id} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pendingRequests.set(id, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
    ipc.send({ ...msg as object, requestId: id });
  });
}

// Handle IPC responses + inbound channel messages
ipc.on("message", (msg: any) => {
  if (msg.requestId && pendingRequests.has(msg.requestId)) {
    pendingRequests.get(msg.requestId)!(msg);
    pendingRequests.delete(msg.requestId);
  } else if (msg.type === "channel_message") {
    // Push inbound message to Claude via MCP channel notification
    // The MCP SDK channel push mechanism will be used here
    server.server.notification({
      method: "notifications/message",
      params: msg.payload,
    });
  }
});

// Start
async function main() {
  await ipc.connect();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("MCP server failed to start:", err);
  process.exit(1);
});
```

Note: The exact MCP channel push API will be determined in Step 3 (research). The `server.server.notification()` call above is a placeholder — replace with the actual mechanism found in the official plugin source.

- [ ] **Step 5: Add build step to copy plugin structure**

Update `tsconfig.json` or add a post-build script to copy `src/plugin/` to `dist/plugin/` and compile `mcp-server.ts` to `dist/plugin/ccd-channel/server.js`.

- [ ] **Step 6: Verify plugin structure compiles**

Run: `npm run build`
Expected: `dist/plugin/ccd-channel/server.js` exists alongside `.claude-plugin/plugin.json` and `.mcp.json`

- [ ] **Step 7: Commit**

```bash
git add src/channel/mcp-server.ts src/plugin/ package.json package-lock.json
git commit -m "feat: add MCP channel server + local plugin structure"
```

---

## Task 8: Approval System Refactor

**Files:**
- Create: `src/approval/approval-server.ts`
- Create: `src/approval/pty-detector.ts`
- Create: `tests/approval/approval-server.test.ts`
- Create: `tests/approval/pty-detector.test.ts`

- [ ] **Step 1: Write failing tests for approval server**

```typescript
// tests/approval/approval-server.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { ApprovalServer } from "../src/approval/approval-server.js";
import type { MessageBus } from "../src/channel/message-bus.js";

describe("ApprovalServer", () => {
  let server: ApprovalServer;

  afterEach(async () => {
    await server?.stop();
  });

  it("starts on specified port", async () => {
    const mockBus = { requestApproval: vi.fn().mockResolvedValue({ decision: "approve", respondedBy: { channelType: "mock", userId: "1" } }) } as unknown as MessageBus;
    server = new ApprovalServer(mockBus, 0); // port 0 = random
    const port = await server.start();
    expect(port).toBeGreaterThan(0);
  });

  it("auto-approves safe tools", async () => {
    const mockBus = { requestApproval: vi.fn() } as unknown as MessageBus;
    server = new ApprovalServer(mockBus, 0);
    const port = await server.start();

    const res = await fetch(`http://127.0.0.1:${port}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool_name: "Read", tool_input: { file_path: "/tmp/foo" } }),
    });
    const body = await res.json();
    expect(body.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(mockBus.requestApproval).not.toHaveBeenCalled();
  });

  it("forwards dangerous tools to messageBus for approval", async () => {
    const mockBus = {
      requestApproval: vi.fn().mockResolvedValue({
        decision: "approve",
        respondedBy: { channelType: "telegram", userId: "123" },
      }),
    } as unknown as MessageBus;
    server = new ApprovalServer(mockBus, 0);
    const port = await server.start();

    const res = await fetch(`http://127.0.0.1:${port}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool_name: "Bash", tool_input: { command: "rm -rf /important" } }),
    });
    const body = await res.json();
    expect(mockBus.requestApproval).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/approval/approval-server.test.ts`

- [ ] **Step 3: Implement ApprovalServer**

Extract the approval logic from the current `ensureStatusLineScript` method (the PreToolUse hook patterns and danger detection) into `src/approval/approval-server.ts`. The server:
- Listens on configurable port
- Auto-approves safe tools (Read, Edit, Write, Glob, Grep, WebFetch, etc. + MCP channel tools)
- Hard-denies destructive patterns (rm -rf /, git push --force, etc.)
- For everything else: calls `messageBus.requestApproval()` and returns the result
- Returns properly formatted `hookSpecificOutput` JSON

- [ ] **Step 4: Write failing tests for PTY detector**

```typescript
// tests/approval/pty-detector.test.ts
import { describe, it, expect } from "vitest";
import { detectPermissionPrompt } from "../src/approval/pty-detector.js";

describe("PTY Detector", () => {
  it("detects permission prompt pattern", () => {
    const text = "Claude wants to edit .claude/settings.json\n1.Yes  2.Yes,andallow...  3.No";
    expect(detectPermissionPrompt(text)).toBe(true);
  });

  it("does not false-positive on normal output", () => {
    expect(detectPermissionPrompt("Hello world")).toBe(false);
  });

  it("does not false-positive on partial match", () => {
    expect(detectPermissionPrompt("1.Yes but no 3.No pattern")).toBe(false);
  });
});
```

- [ ] **Step 5: Implement PTY detector**

Extract from `cli.ts:219` the pattern `clean.includes("1.Yes") && clean.includes("3.No")` into a standalone function + handler that calls `messageBus.requestApproval()`:

```typescript
// src/approval/pty-detector.ts
import type { MessageBus } from "../channel/message-bus.js";

export function detectPermissionPrompt(text: string): boolean {
  return text.includes("1.Yes") && text.includes("3.No");
}

export class PtyApprovalHandler {
  constructor(
    private messageBus: MessageBus,
    private sendInput: (text: string) => void,
    private logger: { info: (...args: any[]) => void; warn: (...args: any[]) => void },
  ) {}

  async handlePrompt(promptText: string): Promise<void> {
    this.logger.info("PTY permission prompt detected — forwarding to channels");
    try {
      const result = await this.messageBus.requestApproval(
        `⚠️ PTY 權限請求:\n${promptText.slice(0, 500)}`,
      );
      if (result.decision === "approve") {
        this.logger.info("PTY permission approved");
        this.sendInput("1");
      } else {
        this.logger.info("PTY permission denied");
        this.sendInput("3");
      }
    } catch {
      this.logger.warn("PTY permission approval failed — auto-denying");
      this.sendInput("3");
    }
  }
}
```

- [ ] **Step 6: Run all approval tests**

Run: `npx vitest run tests/approval/`
Expected: ALL PASS

- [ ] **Step 7: Commit**

```bash
git add src/approval/ tests/approval/
git commit -m "feat: add ApprovalServer and PtyApprovalHandler using MessageBus"
```

---

## Task 9: Refactor ProcessManager for Instance-Scoped Paths

**Files:**
- Modify: `src/process-manager.ts`
- Modify: `tests/process-manager.test.ts`

- [ ] **Step 1: Update ProcessManager constructor and remove global exports**

Remove the exported `STATUSLINE_FILE` constant. Change from using global `DATA_DIR` to accepting an `instanceDir` parameter. All consumers (`cli.ts`, `daemon.ts`) must derive the statusline path from `instanceDir` instead of importing the constant.

```typescript
interface ProcessManagerConfig {
  instanceDir: string;       // e.g., ~/.claude-channel-daemon/instances/project-a/
  workingDirectory: string;
  restartPolicy: DaemonConfig["restart_policy"];
  approvalPort: number;
  pluginDir: string;         // path to dist/plugin/
}

export class ProcessManager extends EventEmitter {
  constructor(
    private pmConfig: ProcessManagerConfig,
    private logger: Logger,
  ) { ... }
}
```

Derive all paths from `instanceDir`:
- `SESSION_FILE` → `join(instanceDir, "session-id")`
- `STATUSLINE_FILE` → `join(instanceDir, "statusline.json")`
- `STATUSLINE_SCRIPT` → `join(instanceDir, "statusline.sh")`
- Settings file → `join(instanceDir, "claude-settings.json")`

- [ ] **Step 2: Update spawnChild to use --plugin-dir + --channels**

Replace:
```typescript
args.push("--channels", `plugin:${this.config.channel_plugin}`);
```

With:
```typescript
args.push("--plugin-dir", this.pmConfig.pluginDir);
args.push("--channels", "plugin:ccd-channel");
```

Add env vars for the MCP server:
```typescript
env: {
  ...process.env,
  TERM: "xterm-256color",
  CCD_SOCKET_PATH: join(this.pmConfig.instanceDir, "channel.sock"),
  CCD_APPROVAL_PORT: String(this.pmConfig.approvalPort),
},
```

- [ ] **Step 3: Update settings file generation**

In `ensureStatusLineScript`, update:
- Tool allow-list: replace `mcp__plugin_telegram_telegram__*` with `mcp__plugin_ccd-channel_ccd-channel__*`
- Approval URL: use `this.pmConfig.approvalPort` instead of hardcoded 18321
- Status line script: write to instance-scoped path

- [ ] **Step 4: Update tests**

```typescript
// tests/process-manager.test.ts
describe("ProcessManager", () => {
  let pm: ProcessManager;
  const logger = createLogger("silent");

  beforeEach(() => {
    pm = new ProcessManager({
      instanceDir: "/tmp/ccd-test",
      workingDirectory: "/tmp",
      restartPolicy: DEFAULT_CONFIG.restart_policy,
      approvalPort: 18321,
      pluginDir: "/tmp/plugin",
    }, logger);
  });
  // ... existing tests unchanged (they test backoff, not paths)
});
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/process-manager.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/process-manager.ts tests/process-manager.test.ts
git commit -m "refactor: ProcessManager accepts instance-scoped paths, uses local plugin"
```

---

## Task 10: Daemon Orchestrator

**Files:**
- Create: `src/daemon.ts`
- Create: `tests/daemon.test.ts`

- [ ] **Step 1: Write failing test**

Test that daemon wires up all components and handles lifecycle:

```typescript
// tests/daemon.test.ts
import { describe, it, expect, vi } from "vitest";
import { Daemon } from "../src/daemon.js";
import type { InstanceConfig } from "../src/types.js";

describe("Daemon", () => {
  it("creates with valid config", () => {
    const config: InstanceConfig = {
      working_directory: "/tmp/test",
      channels: [{
        type: "telegram",
        bot_token_env: "TEST_BOT_TOKEN",
        access: { mode: "locked", allowed_users: [111], max_pending_codes: 3, code_expiry_minutes: 60 },
      }],
      restart_policy: { max_retries: 10, backoff: "exponential", reset_after: 300 },
      context_guardian: { threshold_percentage: 80, max_age_hours: 4, strategy: "hybrid" },
      memory: { auto_summarize: false, watch_memory_dir: true, backup_to_sqlite: true },
      log_level: "info",
    };
    const daemon = new Daemon("test-instance", config, "/tmp/ccd/instances/test");
    expect(daemon).toBeDefined();
  });
});
```

- [ ] **Step 2: Implement Daemon**

`src/daemon.ts` is the single-instance orchestrator. It wires up:
1. Channel adapters (from config.channels) + AccessManagers
2. MessageBus (registers all adapters)
3. IPC server (Unix socket)
4. ProcessManager (with instance-scoped paths)
5. ContextGuardian
6. MemoryLayer + MemoryDb
7. ApprovalServer (on allocated port)
8. PtyApprovalHandler
9. Transcript polling (extracted from cli.ts)

Key methods:
- `async start()` — start all components in order
- `async stop()` — graceful shutdown in reverse order
- Signal handler setup (SIGTERM/SIGINT)
- Context rotation handler

This is essentially the current `cli.ts start` action, but extracted into a class and parameterized.

- [ ] **Step 3: Run tests**

Run: `npx vitest run tests/daemon.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/daemon.ts tests/daemon.test.ts
git commit -m "feat: add Daemon orchestrator class"
```

---

## Task 11: Fleet Manager

**Files:**
- Create: `src/fleet-manager.ts`
- Create: `tests/fleet-manager.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/fleet-manager.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

describe("FleetManager", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ccd-fleet-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("allocates ports automatically", () => {
    const fm = new FleetManager(tmpDir);
    const ports = fm.allocatePorts({
      "project-a": {},
      "project-b": {},
      "project-c": { approval_port: 19000 },
    } as any);
    expect(ports["project-a"]).toBe(18321);
    expect(ports["project-b"]).toBe(18322);
    expect(ports["project-c"]).toBe(19000);
  });

  it("detects instance status correctly", () => {
    const instanceDir = join(tmpDir, "instances", "test");
    mkdirSync(instanceDir, { recursive: true });
    // No PID file → stopped
    const fm = new FleetManager(tmpDir);
    expect(fm.getInstanceStatus("test")).toBe("stopped");
  });

  it("detects crashed instance (stale PID file)", () => {
    const instanceDir = join(tmpDir, "instances", "test");
    mkdirSync(instanceDir, { recursive: true });
    writeFileSync(join(instanceDir, "daemon.pid"), "99999999"); // fake PID
    const fm = new FleetManager(tmpDir);
    expect(fm.getInstanceStatus("test")).toBe("crashed");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/fleet-manager.test.ts`

- [ ] **Step 3: Implement FleetManager**

```typescript
// src/fleet-manager.ts
import { fork, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const BASE_APPROVAL_PORT = 18321;

export class FleetManager {
  private children: Map<string, ChildProcess> = new Map();

  constructor(private dataDir: string) {}

  allocatePorts(instances: Record<string, { approval_port?: number }>): Record<string, number> {
    const ports: Record<string, number> = {};
    let autoPort = BASE_APPROVAL_PORT;
    for (const [name, config] of Object.entries(instances)) {
      if (config.approval_port) {
        ports[name] = config.approval_port;
      } else {
        ports[name] = autoPort++;
      }
    }
    return ports;
  }

  getInstanceDir(name: string): string {
    return join(this.dataDir, "instances", name);
  }

  getInstanceStatus(name: string): "running" | "stopped" | "crashed" {
    const pidPath = join(this.getInstanceDir(name), "daemon.pid");
    if (!existsSync(pidPath)) return "stopped";
    const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
    try {
      process.kill(pid, 0);
      return "running";
    } catch {
      return "crashed";
    }
  }

  async startInstance(name: string, config: any, port: number): Promise<void> {
    const instanceDir = this.getInstanceDir(name);
    mkdirSync(instanceDir, { recursive: true });

    // Fork a child process that runs the daemon (src/daemon-entry.ts → dist/daemon-entry.js)
    const child = fork(join(__dirname, "daemon-entry.js"), [
      "--instance", name,
      "--instance-dir", instanceDir,
      "--port", String(port),
      "--config", JSON.stringify(config),
    ], {
      cwd: config.working_directory,
      detached: false,
    });

    this.children.set(name, child);

    child.on("exit", (code) => {
      this.children.delete(name);
    });
  }

  async stopInstance(name: string): Promise<void> {
    const child = this.children.get(name);
    if (child) {
      child.kill("SIGTERM");
      this.children.delete(name);
      return;
    }
    // Try PID file
    const pidPath = join(this.getInstanceDir(name), "daemon.pid");
    if (existsSync(pidPath)) {
      const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
      try { process.kill(pid, "SIGTERM"); } catch {}
    }
  }

  async stopAll(): Promise<void> {
    const promises = [...this.children.keys()].map(name => this.stopInstance(name));
    await Promise.allSettled(promises);
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/fleet-manager.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Create daemon-entry.ts**

```typescript
// src/daemon-entry.ts
// Thin entry point for fleet-forked child processes.
// Parses CLI args and instantiates a Daemon.
import { Daemon } from "./daemon.js";
import type { InstanceConfig } from "./types.js";

const args = process.argv.slice(2);
const nameIdx = args.indexOf("--instance");
const dirIdx = args.indexOf("--instance-dir");
const portIdx = args.indexOf("--port");
const configIdx = args.indexOf("--config");

if (nameIdx === -1 || dirIdx === -1 || portIdx === -1 || configIdx === -1) {
  console.error("Usage: daemon-entry --instance <name> --instance-dir <dir> --port <port> --config <json>");
  process.exit(1);
}

const name = args[nameIdx + 1];
const instanceDir = args[dirIdx + 1];
const port = parseInt(args[portIdx + 1], 10);
const config: InstanceConfig = JSON.parse(args[configIdx + 1]);
config.approval_port = port;

const daemon = new Daemon(name, config, instanceDir);
daemon.start().catch((err) => {
  console.error("Daemon failed to start:", err);
  process.exit(1);
});
```

- [ ] **Step 6: Commit**

```bash
git add src/fleet-manager.ts src/daemon-entry.ts tests/fleet-manager.test.ts
git commit -m "feat: add FleetManager for multi-instance orchestration"
```

---

## Task 12: CLI Refactor

**Files:**
- Modify: `src/cli.ts`

- [ ] **Step 1: Add fleet commands**

Add `fleet` command group with start/stop/status/logs subcommands. The fleet commands:
- Load `fleet.yaml` via `loadFleetConfig()`
- Allocate ports via `FleetManager.allocatePorts()`
- Start/stop instances via `FleetManager`
- Status shows table with instance name, status, uptime, context%, channel

- [ ] **Step 2: Add access commands**

Add `access` command group:
```
ccd access <instance> lock
ccd access <instance> unlock
ccd access <instance> list
ccd access <instance> remove <uid>
ccd access <instance> pair <code>
```

These read/write the access state files in `~/.claude-channel-daemon/instances/<name>/access/`.

- [ ] **Step 3: Refactor single-instance start**

Keep `ccd start` working by:
1. Loading `config.yaml` (old format)
2. Converting `DaemonConfig` to `InstanceConfig` for backward compat
3. Creating a single Daemon instance with dataDir = `~/.claude-channel-daemon/` (not instance-scoped)

- [ ] **Step 4: Update install/uninstall for fleet**

Add `ccd fleet install` and `ccd fleet uninstall`. Single `ccd install` still works for single-instance mode.

- [ ] **Step 5: Test CLI manually**

Run: `npx tsx src/cli.ts fleet status`
Expected: Shows empty table (no fleet.yaml yet)

Run: `npx tsx src/cli.ts --help`
Expected: Shows fleet, access, and legacy commands

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts
git commit -m "feat: add fleet and access CLI commands, refactor start for daemon delegation"
```

---

## Task 13: Integration Testing

**Files:**
- Modify existing test files as needed

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: ALL tests pass (old + new)

- [ ] **Step 2: Fix any broken imports or types**

The existing tests for `config.test.ts`, `process-manager.test.ts`, `context-guardian.test.ts` may need import updates due to refactored types. Fix any compilation errors.

- [ ] **Step 2.5: Add backward-compat test for legacy config.yaml**

Test that `ccd start` with an old-format `config.yaml` (containing `channel_plugin: telegram@...`) still works by converting `DaemonConfig` to `InstanceConfig` and constructing a Daemon.

- [ ] **Step 3: Build verification**

Run: `npm run build`
Expected: Clean build with no errors. Verify `dist/plugin/ccd-channel/` exists.

- [ ] **Step 4: Manual smoke test (single-instance mode)**

1. Create a test `config.yaml` with a Telegram bot token
2. Run `npx tsx src/cli.ts start -c /path/to/config.yaml`
3. Verify: daemon starts, Telegram bot connects, messages forward to Claude

- [ ] **Step 5: Manual smoke test (fleet mode)**

1. Create a test `fleet.yaml` with one instance
2. Run `npx tsx src/cli.ts fleet start`
3. Verify: fleet manager spawns one daemon child process

- [ ] **Step 6: Commit any fixes**

```bash
git add -A
git commit -m "fix: integration test fixes and build verification"
```

---

## Implementation Order Summary

```
Task 1:  Types + Config Foundation          (foundation)
Task 2:  Channel Abstraction Types          (foundation)
Task 3:  Access Manager                     (standalone, testable)
Task 4:  IPC Bridge                         (standalone, testable)
Task 5:  MessageBus                         (depends on Task 2)
Task 6:  Telegram Adapter                   (depends on Tasks 2, 3)
Task 7:  MCP Channel Server + Plugin        (depends on Task 4)
Task 8:  Approval System Refactor           (depends on Task 5)
Task 9:  ProcessManager Refactor            (depends on Task 7)
Task 10: Daemon Orchestrator                (depends on Tasks 3-9)
Task 11: Fleet Manager                      (depends on Task 10)
Task 12: CLI Refactor                       (depends on Tasks 10, 11)
Task 13: Integration Testing                (depends on all)
```

Tasks 3 and 4 can be done in parallel. Tasks 5 and 6 can be done in parallel.
