# Topic Command UX Design

## Problem

Current topic binding flow requires users to understand Telegram Forum Topics, manually create one, send a message to trigger a directory browser, then select a project. Too many steps, too Telegram-specific.

## Solution

Turn the General topic into a control panel. Users manage project bindings via `/open` and `/new` commands. Topic creation is fully automated by the system.

## Commands

All commands are only valid in the General topic of the Telegram group.

### `/open`

List all unbound directories under configured `project_roots` as a paginated inline keyboard (page size 5, matching existing pattern). User taps one to bind.

System then:
1. Calls `createForumTopic` with the directory basename as topic name
2. Creates instance config, saves `fleet.yaml`, starts daemon (reuse existing bind sequence from `handleDirectorySelection`)
3. Sends confirmation in the new topic

### `/open <keyword>`

Substring match (case-insensitive) across all unbound directories in `project_roots`.

- **Exact basename match** (keyword equals one directory basename exactly, case-insensitive, and no other directory has that exact basename): auto-bind immediately.
- **Multiple substring matches**: list as inline keyboard for user to pick.
- **Zero matches**: reply with "No projects found matching `<keyword>`."

Note: exact-match check takes priority over substring. `/open myapp` binds directly to `myapp` even if `myapp-v2` also exists as a substring match.

### `/new <name>`

Create a new project from scratch.

1. Validate name (no `/`, `..`, whitespace-only, or names starting with `-`)
2. Check that `project_roots[0]/<name>` does not already exist
3. Create directory + `git init` (can run in parallel with step 4)
4. Call `createForumTopic` with `<name>` as topic name
5. Create instance config, save `fleet.yaml`, start daemon (reuse existing bind sequence)
6. Send confirmation: "Bound to `<path>` — instance `<name>`"

If `<name>` is omitted, reply: "Usage: `/new <project-name>`"

If `project_roots` is empty/not configured, reply: "No project roots configured. Run `ccd init` to set up."

## Unbound Topic Behavior

When a user sends a message to a manually-created (unbound) topic, reply:

> "Please use /open or /new in General to bind a project to a topic."

## What Stays the Same

- Topic deletion auto-unbind (existing `handleTopicDeleted` + polling cleanup).
- `fleet.yaml` instance structure — no schema changes.
- IPC, Daemon, message routing.
- DM mode (this only applies to topic mode).

## Implementation Scope

### Critical routing change

The current `handleInboundMessage` early-returns when `threadId == null` (General topic). Change this to route to `handleGeneralCommand()` instead. The adapter already maps `msg.message_thread_id` to `undefined` when absent, so detect General topic as `threadId === undefined`.

### Reuse existing code

The following already exist and should be reused, not reimplemented:

| Need | Existing code |
|------|--------------|
| Scan `project_roots` | `listProjectDirectories()` + `getProjectRoots()` |
| Build inline keyboard | `InlineKeyboard` from grammY, `sendTextWithKeyboard()` on adapter |
| `createForumTopic` | Extract from `autoCreateTopics()` into shared method |
| Bind sequence (config write + start daemon + IPC connect) | Extract from `handleDirectorySelection()` into shared method |
| Name validation | Extend existing check in `handleNewProjectName()` |
| Save config | `saveFleetConfig()` |

### Replace old flow

Replace `handleDirectorySelection()`, `handleNewProjectName()`, and `pendingBindings` state machine with the new `/open` and `/new` handlers. The existing `callback_query` listener stays — extend its prefix dispatch to handle `cmd_open:*` callbacks alongside removing the old `bind:*`, `page:*`, and `newproj:*` prefixes.

Also evaluate whether `autoCreateTopics()` is still needed — with the new flow, topic creation always happens via `/open` or `/new`, so instances should always have a `topic_id` by the time the fleet starts.

### Callback data: 64-byte limit

Telegram `callback_data` has a 64-byte hard limit. Use a numeric index instead of full paths. The FleetManager holds a single `currentOpenSession: { id: string; paths: string[] } | null` field. When `/open` sends a keyboard, it generates a short session ID (8 hex chars) and stores the path list. Callback format: `cmd_open:<sessionId>:<index>`. Any callback with a non-matching session ID is answered with "This menu has expired. Use /open again." Only one active `/open` keyboard at a time — issuing a new `/open` invalidates the previous one.

### Bot commands registration

On fleet startup, call `setMyCommands` with `BotCommandScopeChat` scoped to `channel.group_id` from `fleet.yaml`. This is idempotent and cheap (one HTTPS call). Wrap in try/catch — log on failure, don't block startup.

## Edge Cases

- **`/new` with existing directory name**: error message, don't overwrite.
- **Multiple `project_roots`**: `/open` lists all of them. `/new` uses the first one.
- **General topic messages that aren't commands**: ignore silently.
- **Topic creation API failure**: reply with error in General. Rollback partial state — for `/new`, delete created directory; for both, remove instance from config if partially written.
- **Empty `project_roots`**: reply with setup instructions.
- **`setMyCommands` failure**: log warning, continue startup.
