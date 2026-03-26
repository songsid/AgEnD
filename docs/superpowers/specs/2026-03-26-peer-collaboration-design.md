# Peer-to-Peer Agent Collaboration

## Summary

Enable every CCD instance to autonomously discover and collaborate with other instances. Add a General Topic instance as a natural language entry point. No special Dispatcher role — all instances are equal peers with collaboration capabilities.

## Motivation

CCD's current cross-instance messaging (`send_to_instance`, `list_instances`) enables basic fire-and-forget communication. However:

1. Instances cannot start other stopped instances — collaboration fails if the target is offline.
2. `list_instances()` returns only names — an instance cannot determine who can help with what.
3. No General Topic instance exists to serve as a natural language entry point for tasks that don't belong to a specific project.

This design closes these gaps with minimal changes: two new MCP tools, one enhanced tool, and a General Topic instance configuration.

## Design

### New MCP Tool: `start_instance(name)`

Allows any instance to request fleet manager to start a stopped instance.

**Flow (three-hop, matching existing architecture):**
1. Instance A calls `start_instance("blog")`
2. MCP server sends `{ type: "tool_call", tool: "start_instance", args: { name: "blog" }, requestId }` via IPC to daemon
3. Daemon's `handleToolCall()` classifies it as a fleet-routed tool and sends `{ type: "fleet_start_instance", name: "blog" }` to fleet manager
4. Fleet manager starts the instance using existing startup logic, waits until IPC connected
5. Fleet manager responds via IPC → daemon → MCP server → returns to Claude

**Response:**
```json
{ "success": true }
// or
{ "success": false, "error": "Instance not found in fleet config" }
```

**Edge cases:**
- Instance already running → return success immediately
- Instance not found in fleet config → return error
- Instance fails to start → return error after timeout (60s)

### New MCP Tool: `create_instance(directory, topic_name?)`

Allows any instance (primarily General) to create a new instance with a Telegram topic. Replaces `/open` and `/new`.

**Flow (three-hop):**
1. Instance calls `create_instance({ directory: "~/Documents/Hack/blog" })`
2. MCP server → daemon → fleet manager (same pattern as `start_instance`)
3. Fleet manager executes steps sequentially, rolling back on failure:
   a. Validate directory exists
   b. Generate instance name from directory basename (reuse `sanitizeInstanceName` from `topic-commands.ts`)
   c. Create Telegram forum topic
   d. Register instance in fleet config (write `fleet.yaml`)
   e. Start the instance (tmux + daemon + IPC)
4. Returns `{ success: true, name: "blog", topic_id: 1385 }`

**Parameters:**
- `directory` (required): absolute path or `~`-prefixed path to the project
- `topic_name` (optional): name for the Telegram topic. Defaults to directory basename.

**Rollback on failure:** Steps are ordered so that earlier steps are easy to undo:
- Step c fails (topic creation) → nothing to clean up, directory was only validated
- Step d fails (config write) → delete the Telegram topic
- Step e fails (instance start) → remove config entry, delete the Telegram topic

This is the same pattern as a database migration — ordered steps with reverse cleanup. The fleet manager already handles instance lifecycle, so each rollback step uses existing code.

**Edge cases:**
- Directory does not exist → return error
- Instance for this directory already exists → return existing instance info (name, topic_id, status)
- Multiple directories match a fuzzy input → return candidates list, let Claude ask user to clarify

### Enhanced: `list_instances()`

**Current response:**
```json
{ "instances": ["blog", "ccd", "research"] }
```

**Enhanced response:**
```json
{
  "instances": [
    {
      "name": "blog",
      "status": "running",
      "working_directory": "~/Documents/Hack/blog"
    },
    {
      "name": "ccd",
      "status": "stopped",
      "working_directory": "~/Documents/Hack/claude-channel-daemon"
    }
  ]
}
```

**New fields:**
- `status`: `"running"` | `"stopped"` | `"starting"` | `"rotating"`
- `working_directory`: project path from fleet config

The `working_directory` is sufficient for Claude to infer what each instance does. No `description` field needed — less config to maintain.

**Implementation:** Fleet manager already knows all configured instances (from fleet config) and which are running (from `this.daemons`). Merge both sources to produce the full list.

**Error message improvement:** When `send_to_instance` targets a stopped instance, the error message should say: `"Instance 'X' is stopped. Use start_instance('X') to start it first."` instead of the current generic "Instance or session not found."

### General Topic Instance

A regular CCD instance that receives messages sent to the General Topic. Its behavior comes entirely from its project's `CLAUDE.md`:

```markdown
# General Assistant

You are the general-purpose entry point for this CCD fleet.

## Behavior

- Simple tasks (web search, translation, general questions): handle yourself.
- Tasks that belong to a specific project: use list_instances() to find the right agent, start_instance() if needed, then send_to_instance() to delegate.
- Tasks requiring multiple agents: coordinate by sending to each, collect responses, synthesize.
- User wants a new project agent: use create_instance() to set it up.
- When you receive a task from another instance via send_to_instance(), always reply back with results when done.

## Delegation Guidelines

Only delegate when there is a concrete reason:
- The task requires access to a specific project's files
- The task benefits from parallel execution across agents
- Your context is better preserved by offloading unrelated work
- Never delegate back to the instance that delegated to you

If you can do it yourself, just do it.
```

**Routing:** The fleet manager's `handleInboundMessage` currently treats `threadId == null` as General Topic and routes to `topicCommands.handleGeneralCommand()`. The General instance needs to receive these messages instead. Implementation must investigate whether Telegram surfaces General Topic as `threadId: null`, `threadId: 1`, or another value, and route accordingly. The existing `/open`, `/new`, `/status` commands continue to work — General instance receives them as regular text and can ignore the `/` prefix since it handles everything via natural language.

**Coexistence with slash commands:** Existing slash commands (`/open`, `/new`, `/meets`, `/debate`, `/collab`, `/status`) remain functional. The General instance receives ALL General Topic messages. Messages starting with `/` are handled by both the existing command handler AND forwarded to the General instance. Over time, as the General instance proves capable, slash commands can be deprecated in a follow-up iteration.

No special code, no `role` field, no routing table. The instance discovers available agents at runtime via `list_instances()`.

## What This Does NOT Include

- **Removing `/meets`, `/debate`, `/collab`** — These implement sophisticated logic (ephemeral instances, git worktrees, role assignment) that cannot be replicated by `send_to_instance` alone. They coexist with the General instance. Deprecation is a future consideration once peer collaboration proves sufficient.
- **Request-response protocol between instances** — Agents use `send_to_instance()` for both request and response. Correlation is handled by Claude's semantic understanding, not a technical protocol.
- **Dispatcher role or routing table** — No special instance type. General instance is just an instance with a generalist prompt.
- **`description` field in fleet.yaml** — `working_directory` is sufficient for Claude to infer instance purpose.

## Risks

| Risk | Mitigation |
|---|---|
| Agent forgets to report back after delegation | Prompt convention in every instance's CLAUDE.md: "When you receive a task from another instance, always send_to_instance() back with results when done" |
| General instance context rotation during multi-agent coordination | Keep General instance lightweight (no heavy coding tasks). Raise rotation threshold to 80%. Accept that in-flight coordination may be lost during rotation — user can re-request. |
| `create_instance` fails mid-way (e.g., topic created but instance won't start) | Ordered rollback: undo steps in reverse order. Each step uses existing fleet manager code. |
| Circular delegation (A → B → A) | Prompt convention: "Never delegate back to the instance that delegated to you" |
| Agent delegates when it should just do the task | Prompt guidance: "Only delegate when you can't access the project files or need parallelism" |
| `send_to_instance` to stopped instance confuses agent | Improved error message tells agent to use `start_instance()` first |

## Implementation Scope

| Change | Complexity |
|---|---|
| `start_instance` MCP tool + daemon handler + fleet manager handler | Small — follows existing fleet-routed tool pattern |
| `create_instance` MCP tool + daemon handler + fleet manager handler | Medium — topic creation + config write + startup + rollback |
| Enhance `list_instances` response with status + working_directory | Small — merge fleet config with running daemon state |
| Improve `send_to_instance` error message for stopped instances | Trivial |
| General Topic instance routing in fleet manager | Small — route General Topic messages to a configured instance |
| General Topic instance setup | Config only — working directory + CLAUDE.md |
