# Peer-to-Peer Agent Collaboration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable every CCD instance to discover, start, and create other instances — and add a General Topic instance as a natural language entry point for the fleet.

**Architecture:** Two new MCP tools (`start_instance`, `create_instance`) and one enhanced tool (`list_instances`) follow the existing fleet-routed tool pattern: MCP server → daemon `handleToolCall()` → fleet manager IPC handler. A General Topic instance is a regular CCD instance bound to the General Topic, with behavior defined purely by its `CLAUDE.md`.

**Tech Stack:** TypeScript, MCP SDK, Grammy (Telegram), Vitest, Unix socket IPC

**Spec:** `docs/superpowers/specs/2026-03-26-peer-collaboration-design.md`

---

## File Structure

### Files to Create
None — all changes are modifications to existing files. Integration testing is done manually via Telegram since the IPC flow requires a running fleet manager + tmux.

### Files to Modify
| File | Change |
|------|--------|
| `src/channel/mcp-server.ts` | Add `start_instance` and `create_instance` tool definitions; increase IPC timeout for these tools |
| `src/daemon.ts` | Route new tools as fleet-routed in `handleToolCall()` with 60s timeout |
| `src/fleet-manager.ts` | Handle new tools in `handleOutboundFromInstance()` (must make it `async`); enhance `list_instances` response; improve `send_to_instance` error; route General Topic to instance; add `deleteForumTopic()`; persist `general_topic` in `saveFleetConfig()` |
| `src/types.ts` | Add `general_topic?: boolean` to `InstanceConfig` |
| `src/topic-commands.ts` | Export `sanitizeInstanceName` |

### Key Implementation Notes (from review)
- `handleOutboundFromInstance()` is currently **synchronous** — must be changed to `async` for `start_instance` and `create_instance` handlers that use `await`
- `saveFleetConfig()` is **synchronous** (`writeFileSync`) — do not `await` it; also must add `general_topic` field persistence
- Topic creation: use `this.createForumTopic()` (existing on FleetManager at line 722), NOT `this.adapter.createForumTopic()`
- `deleteForumTopic()` does not exist anywhere — must be added to FleetManager
- `sanitizeInstanceName` is not exported from `topic-commands.ts` — must export before importing in fleet-manager
- MCP server `IPC_TIMEOUT_MS` is 30s — new tools need longer timeout; handle per-tool or raise global
- General Topic routing must use `processAttachments()` for photos/voice, and include `thread_id` in meta

---

### Task 1: Enhance `list_instances` Response

**Files:**
- Modify: `src/fleet-manager.ts` (lines 533-549)

- [ ] **Step 1: Modify list_instances handler in fleet-manager.ts**

In `src/fleet-manager.ts`, find the `list_instances` handling block (around line 533-549). Replace the current implementation:

```typescript
// Current: only returns running daemons
// Replace with: merge fleet config (all instances) + running state
case "list_instances": {
  const allInstances = Object.entries(this.fleetConfig.instances)
    .filter(([name]) => name !== instanceName)
    .map(([name, config]) => ({
      name,
      type: "instance" as const,
      status: this.daemons.has(name) ? "running" : "stopped",
      working_directory: config.working_directory,
      topic_id: config.topic_id ?? null,
    }));

  // Also include external sessions (existing logic)
  const externalSessions = [...this.sessionRegistry.entries()]
    .filter(([sessName]) => sessName !== senderLabel)
    .map(([sessName, hostInstance]) => ({
      name: sessName,
      type: "session" as const,
      host: hostInstance,
    }));

  respond({ instances: allInstances, external_sessions: externalSessions });
  break;
}
```

Note: Preserve the existing `type: "instance"` field to avoid breaking current consumers. Use simple `"running"` / `"stopped"` for status — `"rotating"` detection can be added later.

- [ ] **Step 2: Run build check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/fleet-manager.ts
git commit -m "feat: enhance list_instances to return status and working_directory for all configured instances"
```

---

### Task 2: Improve `send_to_instance` Error Message

**Files:**
- Modify: `src/fleet-manager.ts` (around line 485)

- [ ] **Step 1: Update error message**

In `src/fleet-manager.ts`, find the `send_to_instance` error response (around line 485-487). Change from:

```typescript
respond(null, `Instance or session not found: ${targetName}`);
```

To:

```typescript
// Check if instance exists in config but is stopped
const existsInConfig = targetName in this.fleetConfig.instances;
if (existsInConfig) {
  respond(null, `Instance '${targetName}' is stopped. Use start_instance('${targetName}') to start it first.`);
} else {
  respond(null, `Instance or session not found: ${targetName}`);
}
```

- [ ] **Step 2: Run build check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/fleet-manager.ts
git commit -m "feat: improve send_to_instance error message for stopped instances"
```

---

### Task 3: Add `start_instance` MCP Tool

**Files:**
- Modify: `src/channel/mcp-server.ts` (tool definitions, around line 228-385)
- Modify: `src/daemon.ts` (handleToolCall, around line 559-659)
- Modify: `src/fleet-manager.ts` (handleOutboundFromInstance, around line 431-554)

- [ ] **Step 1: Add tool definition in mcp-server.ts**

Add `start_instance` to the tool list in `src/channel/mcp-server.ts`, alongside the existing `send_to_instance` and `list_instances` definitions:

```typescript
{
  name: "start_instance",
  description:
    "Start a stopped CCD instance. Use list_instances() first to check available instances and their status. " +
    "Only needed when the target instance status is 'stopped'.",
  inputSchema: {
    type: "object" as const,
    properties: {
      name: {
        type: "string",
        description: "The instance name to start (from list_instances)",
      },
    },
    required: ["name"],
  },
},
```

- [ ] **Step 2: Route tool in daemon.ts handleToolCall**

In `src/daemon.ts`, find where cross-instance tools are classified (around line 605). Add `start_instance` to the set of fleet-routed tools. Look for the pattern that checks tool name and broadcasts to fleet manager — add `"start_instance"` to whatever list/condition gates the fleet routing path.

The routing code should follow the exact same pattern as `send_to_instance`: create a `fleetReqId`, broadcast `fleet_outbound` with the tool name and args, register a pending response handler with 60s timeout (instead of 30s, since instance startup takes longer).

- [ ] **Step 3: Make handleOutboundFromInstance async**

In `src/fleet-manager.ts`, change the method signature from:
```typescript
private handleOutboundFromInstance(instanceName: string, msg: Record<string, unknown>): void {
```
To:
```typescript
private async handleOutboundFromInstance(instanceName: string, msg: Record<string, unknown>): Promise<void> {
```

Also update the caller (in `connectIpcToInstance`, around line 365) to handle the returned promise — add `.catch(err => this.log.error({ err }, "handleOutboundFromInstance error"))` to avoid unhandled promise rejections.

- [ ] **Step 4: Add start_instance handler in handleOutboundFromInstance**

Add a new case (around line 463):

```typescript
case "start_instance": {
  const targetName = args.name as string;

  // Already running?
  if (this.daemons.has(targetName)) {
    respond({ success: true, status: "already_running" });
    break;
  }

  // Exists in config?
  const instanceConfig = this.fleetConfig.instances[targetName];
  if (!instanceConfig) {
    respond(null, `Instance '${targetName}' not found in fleet config`);
    break;
  }

  try {
    await this.startInstance(targetName, instanceConfig, true);
    // Wait for IPC connection
    await this.connectIpcToInstance(targetName);
    respond({ success: true, status: "started" });
  } catch (err) {
    respond(null, `Failed to start instance '${targetName}': ${(err as Error).message}`);
  }
  break;
}
```

- [ ] **Step 5: Run build check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/channel/mcp-server.ts src/daemon.ts src/fleet-manager.ts
git commit -m "feat: add start_instance MCP tool for cross-instance activation"
```

---

### Task 4: Add `create_instance` MCP Tool

**Files:**
- Modify: `src/channel/mcp-server.ts`
- Modify: `src/daemon.ts`
- Modify: `src/fleet-manager.ts`

- [ ] **Step 1: Export sanitizeInstanceName and add deleteForumTopic**

In `src/topic-commands.ts`, add `export` to `sanitizeInstanceName` (line 11):
```typescript
export function sanitizeInstanceName(raw: string): string {
```

In `src/fleet-manager.ts`, add a `deleteForumTopic` method (alongside existing `createForumTopic` at line 722):
```typescript
private async deleteForumTopic(topicId: number): Promise<void> {
  try {
    await this.adapter.bot.api.deleteForumTopic(this.groupId, topicId);
  } catch (err) {
    this.log.warn({ err, topicId }, "Failed to delete forum topic during rollback");
  }
}
```

Note: Check how the existing `createForumTopic` method accesses the bot API and follow the same pattern.

- [ ] **Step 2: Add tool definition in mcp-server.ts**

```typescript
{
  name: "create_instance",
  description:
    "Create a new CCD instance bound to a project directory, with a new Telegram topic. " +
    "Use this when the user wants to add a new project to the fleet. " +
    "The directory must exist. Returns the instance name and topic ID.",
  inputSchema: {
    type: "object" as const,
    properties: {
      directory: {
        type: "string",
        description: "Absolute path or ~-prefixed path to the project directory",
      },
      topic_name: {
        type: "string",
        description: "Name for the Telegram topic. Defaults to directory basename.",
      },
    },
    required: ["directory"],
  },
},
```

- [ ] **Step 3: Route tool in daemon.ts**

Add `"create_instance"` to the fleet-routed tools set, same pattern as `start_instance` in Task 3 Step 2. Use 60s timeout.

- [ ] **Step 4: Handle in fleet-manager.ts with rollback**

Import `sanitizeInstanceName` from `topic-commands.ts` at the top of the file. Add handler in `handleOutboundFromInstance`:

```typescript
case "create_instance": {
  const directory = (args.directory as string).replace(/^~/, process.env.HOME || "~");
  const topicName = (args.topic_name as string) || path.basename(directory);

  // Validate directory exists
  try {
    await fs.access(directory);
  } catch {
    respond(null, `Directory does not exist: ${directory}`);
    break;
  }

  // Check if already bound
  const existingInstance = Object.entries(this.fleetConfig.instances)
    .find(([_, config]) => config.working_directory === directory);
  if (existingInstance) {
    const [name, config] = existingInstance;
    respond({
      success: true,
      status: "already_exists",
      name,
      topic_id: config.topic_id,
      running: this.daemons.has(name),
    });
    break;
  }

  // Sequential steps with rollback
  let createdTopicId: number | undefined;
  let instanceName: string | undefined;

  try {
    // Step a: Create Telegram topic (use existing FleetManager method, line ~722)
    createdTopicId = await this.createForumTopic(topicName);

    // Step b: Register in config
    instanceName = `${sanitizeInstanceName(path.basename(directory))}-t${createdTopicId}`;
    const instanceConfig: InstanceConfig = {
      working_directory: directory,
      topic_id: createdTopicId,
      ...this.fleetConfig.defaults,
    };
    this.fleetConfig.instances[instanceName] = instanceConfig;
    this.routingTable.set(createdTopicId, { kind: "instance", name: instanceName });
    this.saveFleetConfig();  // synchronous — no await

    // Step c: Start instance
    await this.startInstance(instanceName, instanceConfig, true);
    await this.connectIpcToInstance(instanceName);

    respond({
      success: true,
      name: instanceName,
      topic_id: createdTopicId,
    });
  } catch (err) {
    // Rollback in reverse order
    if (instanceName && this.daemons.has(instanceName)) {
      await this.stopInstance(instanceName).catch(() => {});
    }
    if (instanceName && this.fleetConfig.instances[instanceName]) {
      delete this.fleetConfig.instances[instanceName];
      if (createdTopicId) this.routingTable.delete(createdTopicId);
      this.saveFleetConfig();  // synchronous — no await
    }
    if (createdTopicId) {
      await this.deleteForumTopic(createdTopicId);
    }
    respond(null, `Failed to create instance: ${(err as Error).message}`);
  }
  break;
}
```

- [ ] **Step 5: Run build check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 7: Run all tests**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 8: Commit**

```bash
git add src/channel/mcp-server.ts src/daemon.ts src/fleet-manager.ts src/channel/types.ts src/channel/adapters/telegram.ts
git commit -m "feat: add create_instance MCP tool with rollback on failure"
```

---

### Task 5: General Topic Instance Routing

**Files:**
- Modify: `src/fleet-manager.ts` (handleInboundMessage, around line 385-429)

- [ ] **Step 1: Investigate General Topic thread ID**

Before coding, check how the Telegram adapter reports General Topic messages. In `src/channel/adapters/telegram.ts`, find where `threadId` is set in the inbound message. Determine if General Topic messages have `threadId: undefined`, `threadId: null`, or a specific numeric value.

This is critical — the routing depends on it.

- [ ] **Step 2: Add General Topic instance routing**

In `src/fleet-manager.ts` `handleInboundMessage`, modify the General Topic path (around line 387-391). After the existing slash command handlers, forward the message to a configured General instance:

```typescript
if (threadId == null) {
  // Existing slash command handlers — keep them
  if (await this.topicCommands.handleGeneralCommand(msg)) return;
  if (await this.meetingManager.handleCommand(msg)) return;

  // NEW: Forward to General Topic instance if configured
  const generalInstance = this.findGeneralInstance();
  if (generalInstance) {
    const ipc = this.instanceIpcClients.get(generalInstance);
    if (ipc) {
      // Use processAttachments() for photos/voice — same as bound topic routing
      const processed = await this.processAttachments(msg, generalInstance);
      ipc.send({
        type: "fleet_inbound",
        content: processed.text,
        meta: {
          chat_id: msg.chatId,
          message_id: msg.messageId,
          thread_id: "",  // General Topic has no thread ID
          user: msg.user,
          ts: msg.timestamp,
          ...processed.meta,  // image_path, voice_transcript, etc.
        },
      });
    }
  }
  return;
}
```

Note: Check if `processAttachments` is the correct method name — look at how bound topic messages are processed (around line 401-413 in fleet-manager.ts) and use the same attachment processing flow. The key point is: do NOT skip attachment handling for General Topic messages.

- [ ] **Step 3: Add findGeneralInstance helper**

Add a method to `FleetManager`:

```typescript
private findGeneralInstance(): string | undefined {
  // Find instance with no topic_id or topic_id matching General Topic
  // Convention: an instance with topic_id: 0 or a special marker
  // Simplest: look for an instance named "general" or with a config flag
  for (const [name, config] of Object.entries(this.fleetConfig.instances)) {
    if (config.general_topic === true) {
      return this.daemons.has(name) ? name : undefined;
    }
  }
  return undefined;
}
```

This requires adding `general_topic?: boolean` to `InstanceConfig` in `src/types.ts`.

Alternatively, use a simpler convention: the instance whose `topic_id` is `0` or `1` (depending on what Telegram reports for General Topic). Pick whichever is cleaner after Step 1's investigation.

- [ ] **Step 4: Update InstanceConfig type**

In `src/types.ts`, add the `general_topic` field to `InstanceConfig`:

```typescript
general_topic?: boolean;  // If true, this instance receives General Topic messages
```

- [ ] **Step 5: Update saveFleetConfig to persist general_topic**

In `src/fleet-manager.ts`, find `saveFleetConfig()` (around line 773). It currently only saves `working_directory` and `topic_id`. Add `general_topic`:

```typescript
// In the instance serialization loop, add:
if (config.general_topic) {
  serialized.general_topic = true;
}
```

Without this, the `general_topic: true` flag is lost on daemon restart.

- [ ] **Step 6: Run build check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add src/fleet-manager.ts src/types.ts
git commit -m "feat: route General Topic messages to configured general instance"
```

---

### Task 6: General Topic Instance Setup

**Files:**
- Create: General instance working directory + CLAUDE.md

- [ ] **Step 1: Create General instance directory**

```bash
mkdir -p ~/.claude-channel-daemon/general
```

- [ ] **Step 2: Create CLAUDE.md for General instance**

Write `~/.claude-channel-daemon/general/CLAUDE.md`:

```markdown
# General Assistant

你是這個 CCD fleet 的通用入口。

## 行為準則

- 簡單任務（搜尋、翻譯、一般問答）：自己處理。
- 屬於特定專案的任務：用 list_instances() 找到對應 agent，需要時用 start_instance() 啟動，再用 send_to_instance() 委派。
- 需要多個 agent 協作的任務：協調各 agent 並行或串行執行，收集結果後彙整。
- 使用者想開新的專案 agent：用 create_instance() 建立。
- 收到其他 instance 委派的任務時，完成後一定要用 send_to_instance() 回報結果。

## 委派原則

只在有具體理由時才委派：
- 任務需要存取特定專案的檔案
- 任務可以從多 agent 平行執行中受益
- 保留自己的 context 更重要，把不相關的工作交出去
- 絕不把任務回委給委派你的 instance

自己能做的，就自己做。
```

- [ ] **Step 3: Add General instance to fleet.yaml**

Add the general instance entry to `~/.claude-channel-daemon/fleet.yaml`:

```yaml
instances:
  general:
    working_directory: ~/.claude-channel-daemon/general
    general_topic: true
```

Note: No `topic_id` since General Topic routing is handled by the `general_topic: true` flag, not by topic ID matching.

- [ ] **Step 4: Test manually**

1. Start the fleet: `ccd fleet start`
2. Verify general instance starts: `ccd fleet status`
3. Send a message in General Topic (not a slash command)
4. Verify the General instance receives and responds
5. Test delegation: send "check what instances are available" — should call `list_instances()`
6. Test start: send "start the blog agent" — should call `start_instance()`

- [ ] **Step 5: Commit**

```bash
git add src/fleet-manager.ts
git commit -m "feat: set up General Topic instance with natural language fleet control"
```

---

### Task 7: End-to-End Validation

- [ ] **Step 1: Test create_instance flow**

In Telegram General Topic, send: "幫我開一個新 agent 跑 ~/Documents/Hack/some-project"
Expected: General instance calls `create_instance()` → new topic appears → instance starts

- [ ] **Step 2: Test cross-instance collaboration**

In Telegram General Topic, send: "問一下 blog agent 最近有什麼新文章"
Expected: General instance calls `list_instances()` → finds blog → `start_instance()` if needed → `send_to_instance("blog", ...)` → blog agent responds → General instance replies to user

- [ ] **Step 3: Test error cases**

- Send to General Topic: "開一個 agent 跑 ~/nonexistent" → should get friendly error
- Stop an instance, then ask General to talk to it → should start it automatically

- [ ] **Step 4: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 5: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix: address issues found during e2e validation"
```
