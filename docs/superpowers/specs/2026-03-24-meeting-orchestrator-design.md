# Meeting Orchestrator — Multi-Instance Collaboration

## Overview

A `/meets` command that spawns multiple ephemeral Claude Code instances into a shared Telegram topic (or future channel) for structured discussion or collaborative work. FleetManager acts as the system-level moderator, and a new `MeetingOrchestrator` class manages the session flow.

## Modes

### Debate Mode (default)

Multiple instances argue different sides of a topic. Roles auto-assigned by participant count:

| Count | Roles |
|-------|-------|
| 2 | Pro, Con |
| 3 | Pro, Con, Arbiter |
| 4+ | Pro×N, Con×N, Arbiter (odd count gets extra arbiter) |

Working directory: `/tmp` (no codebase needed).

### Collaboration Mode (`--collab`)

Multiple instances work together on a task in a shared repo. Each instance gets an isolated git worktree. Role assignment happens through instance self-discussion or user direction.

Working directory: per-instance git worktree branching from the target repo.

## Architecture

```
User: /meets "topic"
       │
       ▼
┌──────────────────────────────────────────────────┐
│              FleetManager (existing)              │
│                                                   │
│  • Parse /meets command or interactive wizard     │
│  • Create meeting channel (Telegram topic, etc.)  │
│  • spawnEphemeralInstance() × N                   │
│  • Instantiate MeetingOrchestrator, hand off      │
│  • Route table: topicId → MeetingOrchestrator     │
└──────┬───────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────┐
│         MeetingOrchestrator (new)                 │
│                                                   │
│  • Debate/collab flow control                    │
│  • Turn ordering, prompt composition             │
│  • User intervention handling (absolute priority)│
│  • Summary generation on completion              │
│  • Request FM to destroy instances on end        │
└──────┬───────────────────────────────────────────┘
       │  via FleetManager.sendAndWaitReply()
       ▼
┌──────────┐ ┌──────────┐ ┌──────────┐
│ Daemon A │ │ Daemon B │ │ Daemon C │
│ ephemeral│ │ ephemeral│ │ ephemeral│
└──────────┘ └──────────┘ └──────────┘
     Full Claude Code instances (tmux-backed, via CliBackend)
```

## Command Interface

### Interactive Wizard (primary, mobile-friendly)

```
User: /meets

Bot: 📋 建立新會議
     議題是什麼？（請直接輸入）

User: 要不要拆 monorepo

Bot: 模式？
     [💬 辯論]  [🔨 協作]

User: (taps 💬 辯論)

Bot: 幾位參與者？
     [2]  [3]  [4]

User: (taps 3)

Bot: ✅ 會議建立中...

     📋 會議：要不要拆 monorepo？
     參與者：A（正方）、B（反方）、C（仲裁）
     輪次：3 | 指令：/end /more /pause
```

Collaboration mode adds a repo selection step using inline buttons populated from existing fleet instance working directories.

### CLI Shorthand (power users)

```
/meets "topic"                                → debate, 2 participants
/meets -n 3 "topic"                           → debate, 3 participants
/meets --collab --repo ~/app "task"           → collab mode
/meets -n 2 --names "前端,後端" --collab "task" → collab, custom names
```

## Instance Naming

- Default: A, B, C, D... (short, mode-agnostic, easy to type)
- Custom: `--names "name1,name2"` overrides default labels
- Users reference instances with `@A`, `@B`, etc. in the topic

## Debate Flow

```
Start meeting
  │
  ▼
[Round 1]
  → Send prompt to Pro (A)
  → A replies → post to topic (labeled "🟢 A（正方）")
  → Send "A's argument + please rebut" to Con (B)
  → B replies → post to topic (labeled "🔴 B（反方）")
  → (if arbiter) Send both sides to Arbiter (C)
  → C replies → post to topic (labeled "⚖️ C（仲裁）")
  │
  ▼
[Round 2..N]
  Repeat. Each round carries previous round summary (not full history)
  to control token consumption.
  │
  ▼
[End] Triggered by:
  • Reaching round limit (default: 3)
  • User sends /end
  │
  ▼
[Summary] Arbiter generates summary (if present); otherwise last speaker does.
         Summary prompt includes all round summaries. → post to topic
  │
  ▼
[Cleanup] Notify FleetManager to destroy all ephemeral instances
```

### Prompt Strategy

- Each round sends "previous round summary + opponent's latest argument" — not full conversation history
- Role assigned via `--system-prompt` flag at instance spawn time (e.g., "You are the Pro side. Your position is to support this proposal."). Per-round context (opponent's arguments, user instructions) is sent as regular user messages via IPC.
- User free-text in topic is injected as additional context to the next speaker

## Collaboration Flow

```
/meets --collab --repo ~/app -n 3 "Implement OAuth login"
  │
  ▼
Orchestrator:
  1. git worktree add /tmp/meet-{id}-A -b meet/{id}-A
  2. git worktree add /tmp/meet-{id}-B -b meet/{id}-B
  3. git worktree add /tmp/meet-{id}-C -b meet/{id}-C
  │
  ▼
Discussion phase: instances discuss task division in topic
  │
  ▼
Development phase: each works in own worktree
  │
  ▼
End: Orchestrator attempts to merge branches, reports conflicts to topic
```

## User Control (Absolute Priority)

User messages in the meeting topic always take highest priority. The orchestrator pauses its current flow to handle user input.

### Command Table

| Input | Behavior |
|-------|----------|
| `/end` | Immediately end, enter summary phase |
| `/more` | +1 round |
| `/more 3` | +3 rounds |
| `/pause` | Pause flow, wait for `/resume` |
| `/resume` | Resume paused flow |
| `/kick A` | Remove instance A from meeting |
| `/add` | Spawn additional instance |
| `/redirect A "argue from cost perspective"` | Direct instruction to specific instance |
| `@A what about testing?` | Override turn order, A speaks next with this prompt |
| Free text | Appended as additional context to the next speaker's prompt |

### Principles

1. **User message = pause flow** — regardless of what orchestrator is waiting for
2. **User can change rules anytime** — roles, topic, participant count
3. **User can direct-address** — `@A` bypasses orchestrator scheduling, response posted to topic

## Channel Abstraction

MeetingOrchestrator does not assume Telegram. It outputs structured message objects through an abstract interface:

```typescript
interface MeetingChannelOutput {
  postMessage(text: string, options?: { label?: string }): Promise<string>
  editMessage(messageId: string, text: string): Promise<void>
  createMeetingChannel(title: string): Promise<{ channelId: string }>
  closeMeetingChannel(channelId: string): Promise<void>
}
```

Orchestrator emits structured data:

```typescript
{ speaker: "A", role: "正方", round: 1, content: "..." }
```

Channel adapter decides rendering. Telegram renders as:

```
🟢 A（正方）：
Monorepo 的部署耦合...
```

Future adapters (Slack, Discord) render in their own native formats.

Implementation note: `createMeetingChannel` wraps `FleetManager.createForumTopic()` for Telegram. `closeMeetingChannel` maps to Telegram's `closeForumTopic` Bot API (needs to be added to TelegramAdapter).

## MeetingOrchestrator Interface

```typescript
interface MeetingConfig {
  meetingId: string
  topic: string
  mode: "debate" | "collab"
  participants: ParticipantConfig[]
  maxRounds: number          // default: 3
  repo?: string              // collab mode only
}

interface ParticipantConfig {
  label: string              // "A", "B", or custom name
  role: string               // "正方", "反方", "仲裁", or custom
  systemPrompt: string       // injected via --system-prompt flag at spawn
  workingDirectory: string   // debate: /tmp, collab: worktree path
}

class MeetingOrchestrator {
  constructor(
    config: MeetingConfig,
    fm: FleetManagerMeetingAPI,  // narrow interface, not full FM
    output: MeetingChannelOutput
  )

  /** Boot instances and start the debate/collab flow */
  async start(): Promise<void>

  /** Handle any user message in the meeting topic (absolute priority) */
  handleUserMessage(msg: InboundMessage): void

  /** End meeting: summary → cleanup → destroy instances */
  async end(): Promise<void>
}
```

## FleetManager Extensions

### New Methods

```typescript
// Narrow interface exposed to Orchestrator (not full FleetManager)
interface FleetManagerMeetingAPI {
  spawnEphemeralInstance(config: EphemeralInstanceConfig, signal?: AbortSignal): Promise<string>
  destroyEphemeralInstance(name: string): Promise<void>
  sendAndWaitReply(instanceName: string, message: string, timeoutMs?: number): Promise<string>
}
```

### EphemeralInstanceConfig

```typescript
interface EphemeralInstanceConfig {
  meetingId: string
  label: string               // "A", "B", or custom name
  systemPrompt: string        // role instructions (see Backend Prerequisites below)
  workingDirectory: string    // debate: /tmp, collab: worktree path
  skipPermissions?: boolean   // debate mode: true (see Backend Prerequisites below)
  backend?: string            // defaults to fleet config defaults.backend or "claude-code"
}
```

### `sendAndWaitReply` — Reply Capture Mechanism

This is the most critical new primitive. Today, Claude responds asynchronously via the `reply` tool call, which routes through `fleet_outbound` to Telegram. For meetings, this flow is intercepted:

1. FleetManager sends `fleet_inbound` to the ephemeral instance (same as normal messages)
2. Claude processes the prompt, potentially uses tools, then calls `reply`
3. Daemon emits `fleet_outbound` with `tool=reply`
4. FleetManager checks: is this instance part of an active meeting?
   - **Yes** → resolve the pending `sendAndWaitReply` promise with the reply text. Do NOT post to Telegram.
   - **No** → existing behavior (post to Telegram)
5. Timeout: 120s default, configurable. On timeout, return a timeout error to the orchestrator.

Multiple `reply` calls: concatenate all replies until a 5-second idle period, then resolve.

```
FleetManager.sendAndWaitReply("meet-xyz-A", prompt)
  │
  ├─ send fleet_inbound to Daemon A
  ├─ register pendingMeetingReply["meet-xyz-A"] = { resolve, reject }
  │
  ▼ (async, Claude processes...)

Daemon A fleet_outbound { tool: "reply", args: { text: "..." } }
  │
  ▼
FleetManager.handleOutboundFromInstance("meet-xyz-A", msg)
  ├─ Check: pendingMeetingReply has "meet-xyz-A"?
  ├─ YES → resolve promise with text, don't post to Telegram
  └─ The orchestrator receives the text and posts to topic itself (with formatting)
```

### Approval Strategy for Ephemeral Instances

- **Debate mode**: instances use `--dangerously-skip-permissions` (working in /tmp, no risk)
- **Collab mode**: instances use the same approval strategy as normal fleet instances, with approval prompts routed to the meeting topic

### Routing Extension

```typescript
// Existing (actual type in codebase)
routingTable: Map<number, string>                     // threadId → instanceName

// New
meetingTable: Map<number, MeetingOrchestrator>        // threadId → orchestrator

// Routing logic (meeting topics are always freshly created, no collision with routingTable)
handleInboundMessage(msg) {
  const threadId = parseInt(msg.threadId, 10)
  if (meetingTable.has(threadId)) {
    meetingTable.get(threadId).handleUserMessage(msg)
  } else if (routingTable.has(threadId)) {
    // existing logic
  }
}
```

## Backend Independence

- Orchestrator only calls `FleetManagerMeetingAPI`, never touches CliBackend or Daemon directly
- FleetManager's `spawnEphemeralInstance` uses existing Daemon + CliBackend internally
- Switching backend (e.g., to API-based) only requires the `FleetManagerMeetingAPI` contract to work
- Orchestrator remains unchanged across backend swaps
- System prompt is set via the backend's launch flags (e.g., `--system-prompt` for Claude Code), abstracted away from the orchestrator

## Resource Limits

- Maximum 1 active meeting at a time (configurable via fleet.yaml `meetings.maxConcurrent`)
- Maximum 6 participants per meeting (configurable via `meetings.maxParticipants`)
- Attempting to create a meeting while one is active returns an error to the user
- Instances are spawned in parallel with `Promise.all` + `AbortSignal` for cancellation

## Error Handling

- Instance fails to start → post error to topic, continue with remaining instances
- Instance stops responding (timeout 120s) → post timeout notice, skip turn, continue
- All instances fail → end meeting with error summary
- User sends /end during instance boot → AbortSignal cancels remaining spawns, cleanup started instances
- Collab mode: validate `--repo` path is a git repository before spawning
- Collab cleanup: `git worktree remove --force` + `git branch -D meet/{id}-*`

## Backend Prerequisites

The following extensions to existing interfaces are required before meeting functionality can work:

1. **`CliBackendConfig` needs `systemPrompt?: string`** — `buildCommand()` must append `--system-prompt "..."` to the CLI command when present. This is a supported Claude Code CLI flag.
2. **`CliBackendConfig` needs `skipPermissions?: boolean`** — `buildCommand()` must append `--dangerously-skip-permissions` when true. Used only for debate-mode ephemeral instances (working in /tmp, no risk).
3. **`TelegramAdapter` needs `closeForumTopic(threadId)`** — wraps the Telegram Bot API `closeForumTopic` method.

These are small, isolated changes to existing code and do not affect the Orchestrator design.

## Scope Boundaries (not in v1)

- Writing meeting conclusions back to instance memory (future enhancement)
- Meeting templates / presets
- Persistent meeting history (meetings are ephemeral)
- Cross-meeting instance reuse
