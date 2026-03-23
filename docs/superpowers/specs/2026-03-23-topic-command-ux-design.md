# Topic Command UX Design

## Problem

Current topic binding flow requires users to understand Telegram Forum Topics, manually create one, send a message to trigger a directory browser, then select a project. Too many steps, too Telegram-specific.

## Solution

Turn the General topic into a control panel. Users manage project bindings via `/open` and `/new` commands. Topic creation is fully automated by the system.

## Commands

All commands are only valid in the General topic of the Telegram group.

### `/open`

List all **unbound** directories under configured `project_roots` as an inline keyboard (already-bound projects are excluded from the list). User taps one to bind.

System then:
1. Calls `createForumTopic` with the directory basename as topic name
2. Creates instance config in `fleet.yaml`
3. Starts the daemon instance
4. Sends confirmation in the new topic

### `/open <keyword>`

Fuzzy search (substring match, case-insensitive) across all **unbound** directories in `project_roots`.

- **Exact unique match** (keyword equals directory basename exactly, and only one match): auto-bind immediately, no confirmation needed.
- **Multiple matches**: list all matching directories as inline keyboard for user to pick.
- **Zero matches**: reply with "No projects found matching `<keyword>`."

### `/new <name>`

Create a new project from scratch.

1. Validate name (no `/`, `..`, whitespace-only, or names starting with `-`)
2. Check that `project_roots[0]/<name>` does not already exist
3. Create directory at `project_roots[0]/<name>`
4. Run `git init` in the new directory
5. Call `createForumTopic` with `<name>` as topic name
6. Create instance config + start daemon
7. Send confirmation in the new topic

If `<name>` is omitted, reply: "Usage: `/new <project-name>`"

If `project_roots` is empty/not configured, reply: "No project roots configured. Run `ccd init` to set up."

## Unbound Topic Behavior

When a user sends a message to a manually-created (unbound) topic, the system no longer shows the directory browser. Instead, it replies:

> "Please use /open or /new in General to bind a project to a topic."

This keeps the entry point unified and avoids confusion.

## What Stays the Same

- **Topic deletion auto-unbind**: existing `handleTopicDeleted` + polling cleanup logic unchanged.
- **fleet.yaml instance structure**: no schema changes.
- **IPC, Daemon, message routing**: untouched.
- **DM mode**: unaffected (this only applies to topic mode).

## Implementation Scope

### Critical routing change

The current code in `fleet-manager.ts` (line ~322) early-returns and ignores messages with no `threadId`:

```typescript
if (threadId == null) {
  this.logger.warn(..., "Message without threadId — ignoring in topic mode");
  return;
}
```

This must be changed: messages with `threadId == null` (General topic) must be routed to `handleGeneralCommand()` instead of being dropped.

**Note:** The General topic's `message_thread_id` may be `undefined`, `0`, or `1` depending on the Telegram API version and grammY behavior. The implementation must detect all three as "General topic." Test empirically.

### Modified files

- **`src/fleet-manager.ts`**:
  - Remove early-return for `threadId == null`; route to `handleGeneralCommand()`
  - Add `handleGeneralCommand()` method to parse `/open` and `/new` from General topic messages
  - Add `handleOpenCommand(keyword?: string)` — directory listing/search + auto-create topic + bind
  - Add `handleNewCommand(name: string)` — create dir + git init + auto-create topic + bind
  - Add new callback query handler for `cmd_open:*` callbacks (separate from existing `handleDirectorySelection`)
  - Modify `handleUnboundTopic()` — replace directory browser with redirect message
  - Remove old `pendingBindings` state machine, `handleDirectorySelection()`, and `handleNewProjectName()` (dead code after this change)
  - Register Telegram bot commands via `setMyCommands` API on startup

- **`src/channel/adapters/telegram.ts`**:
  - Ensure General topic messages are forwarded to FleetManager (not filtered out)

### Callback data: 64-byte limit

Telegram inline keyboard `callback_data` has a **64-byte hard limit**. Full filesystem paths easily exceed this. Solution: use a numeric index into a server-side ephemeral map.

```
callback_data: "cmd_open:3"  (not "cmd_open:/Users/suzuke/Documents/Projects/my-project")
```

The FleetManager maintains a `Map<number, string>` (index → full path) that is populated when the inline keyboard is sent and cleared when the keyboard is acted upon or times out.

### Bot commands registration

On fleet startup, call Telegram `setMyCommands` API to register `/open` and `/new` so they appear in Telegram's command autocomplete menu. Scope to the specific group via `BotCommandScopeChat` (not `BotCommandScopeAllGroupChats`) to avoid leaking commands to other groups.

## Edge Cases

- **`/open` when project is already bound**: excluded from the list entirely (only unbound directories shown).
- **`/new` with existing directory name**: error message, don't overwrite.
- **Multiple `project_roots`**: `/open` lists all of them. `/new` uses the first one.
- **General topic messages that aren't commands**: ignore silently (don't reply with the redirect message — that's only for unbound non-General topics).
- **Topic creation API failure**: reply with error in General, don't leave orphan config. Rollback any partial state (delete created directory for `/new`, remove instance from config).
- **Empty `project_roots`**: reply with setup instructions.
- **Stale inline keyboards**: each keyboard gets a unique session ID in callback data. Callbacks with expired/unknown session IDs are answered with "This menu has expired. Use /open again."
- **Duplicate project binding**: not possible — already-bound directories are excluded from `/open` results.
