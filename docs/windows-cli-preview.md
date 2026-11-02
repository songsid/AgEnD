# Windows CLI task preview

This opt-in runtime lets AgEnD running in WSL discover native Windows CLIs and
run Windows agents in the same Fleet instance registry as Linux agents. Runtime
selects the execution adapter; identity, configuration, chat, status, teams and
delivery use the shared Fleet system. The coordinator itself still runs in WSL.

## Enable

Install Windows Node.js and make `node.exe` available on Windows PATH. Install
and sign in to a supported native Windows CLI. Restart AgEnD after adding this to
the AgEnD home's `.env`:

```dotenv
AGEND_WINDOWS_CLI=1
```

Sign in to the local dashboard as an administrator. Open **Settings → Windows CLI**
at `/settings/windows-cli`. The old `/ui/windows-cli` address also opens this
Settings section. Detection shows native executable paths, versions
and sign-in status. Codex, Claude Code, Antigravity, Grok, OpenCode and Muse have
native task adapters. The picker shows installed, compatible task-capable CLIs;
missing tools are hidden. Kiro CLI is recognized separately from Kiro IDE, but
its task adapter remains disabled pending verification of its terminal JSON
protocol. No credential files are copied between Windows and Linux. A provider
without a reliable sign-in status command is marked unknown, never signed out.

Successful inventory is cached for 60 seconds in both the bridge and the page.
Settings and New agent share one in-flight read. Reopening uses the last result
immediately; an expired result stays visible while it refreshes in the background.
Cold detection displays a spinner and explanatory status, with elapsed seconds
after eight seconds. Errors are distinct from an empty inventory and offer Retry.
Detect again explicitly bypasses the cache. Failed refreshes retain the page's
last successful inventory with a warning; execution still checks the actual CLI
and its sign-in before each task. Nothing is persisted to browser storage.

One-off tasks in the Windows CLI settings section use an existing Windows
directory, such as `C:\Projects\example`. Registered agents may leave their
working directory empty, as described below.
Read-only is the default where available: Codex uses its native sandbox, while
Claude exposes only Read, Glob and Grep and disables MCP. Claude's restriction
is a tool policy, not an OS sandbox. Other CLIs require an explicit choice to
use native CLI permissions; plan mode is not treated as proof of read-only access.
No adapter adds a permission/sandbox bypass. The CLI retains its own approval policy
(including any configured automatic reviewer); this page has no interactive
approval controls, so operations needing human input may be denied. This page
does not attach to an existing terminal or adopt an unrelated conversation.

## Create an agent

**New agent** first asks for a runtime: **WSL / Linux** or **Native Windows**.
Creation uses three separate screens: **Choose runtime** (environment and CLI),
**Configure agent** (fields and optional AI assistance), and **Done** (saved agent
summary and Open chat). Selecting a runtime does not expose configuration fields
until Next is pressed. Back preserves the form and AI-description drafts; switching
between runtimes keeps each runtime's draft separately. Only Create sends the
creation request; Next and Back do not create agents.
The Windows form offers a product-icon CLI picker, name, model, description,
instructions, an optional working directory and an explicit file-access mode.
Leave the working directory empty to create a general-purpose agent. Windows
Node creates a persistent per-agent directory under
`%USERPROFILE%\.agend\workspaces\<agent-id>` and returns its actual path in the
creation summary. Each agent retains that directory across turns and restarts.
An explicit working directory must remain an absolute Windows drive path; UNC and
device paths are not supported. AgEnD does not send Windows paths to Linux
filesystem/tmux operations or offer Linux worktree settings.
The created Windows agent appears in the common Instances list and uses the same
chat panel, `/ui/send`, `/ui/history` and SSE stream as Linux instances. It carries
a Windows runtime badge and exposes controls based on its runtime capabilities.
Its provider and native conversation ID are retained and subsequent turns resume
that exact ID; no `--last` selection is used. Older profiles without a provider
remain Codex conversations. Common settings live in `fleet.yaml` with
`runtime: windows`, `native_agent_id` and `native_sandbox`. Native session IDs,
bounded recovery turns and accepted message IDs remain in `windows-agents.json`
as execution-adapter state. Chat uses the shared persisted history; old visible
turns are imported once by stable message IDs, which remain identifiable after
restarts. Older duplicate imports are reconciled against the saved native turns,
using their role, sender, timestamp and recorded text. Distinct turns with the
same text remain distinct. The shared chat uses the explicit message role to
place users on the right and agents on the left, regardless of their display names.
The runtime currently supports
sixteen Windows agents and 4096 accepted message IDs across restarts.

Existing native profiles are registered as `windows-<UUID>` instances without
changing their display names, workspaces or provider conversations. A durable
backlink prevents a profile removed from Fleet config from reappearing on restart.
Old native URLs redirect to the common chat route; the legacy HTTP endpoints are
compatibility aliases over the same registry and delivery facade.

**Let AI fill this in** uses the already signed-in Windows Codex as the initial
AI for drafting either runtime's configuration. It asks for JSON without using
tools, runs with the read-only sandbox, and fills the form's name, directory,
description and instructions. It never changes the selected runtime, backend
or file-access mode, and never creates an agent automatically. The operator
reviews/edits the form and presses Create. No pre-existing AgEnD agent is needed;
a usable Windows Codex installation/sign-in is required for this draft helper.
When no working directory is requested, AI leaves that field empty so creation
uses the agent's own workspace rather than a guessed project or the user home.

A process interrupted across a fleet restart is not retried automatically. Its
agent is blocked until the operator verifies Windows processes have stopped and
explicitly unlocks it. Windows instances can join teams and be assigned tasks,
schedules and incoming delegation through Fleet's durable delivery outbox.
Completion is based on provider terminal events, and requested peer results
return through the same correlation ID. Native agents do not yet receive an
outbound AgEnD MCP tool transport. Attachments, terminal View/Log, raw terminal
input and CLI control commands are unavailable and hidden in the shared UI.
External channel binding is also unavailable; migration never creates topics or
binds native agents to an existing bot's General channel.

## Models and provider support

The model picker in both **New agent** and an existing agent's Settings uses the
selected runtime and CLI. Windows catalogs are separate from WSL account
catalogs. The selector retains **Use the CLI default model**, the saved model
even when it is no longer listed, and **Other…** for a custom model ID. Loading
and errors are shown without preventing the rest of the form from being filled
in; Retry and Refresh models request the list again. Changing a CLI does not
reuse a late response from the previous CLI.

| Native CLI | Task and conversation adapter | Model choices |
| --- | --- | --- |
| Codex | Available; native read-only and workspace-write policies | The native account's `models_cache.json`; no credential file is read for this list |
| Claude Code | Available; read-tool restriction or native CLI policy | Documented Claude choices, gated by installed CLI version |
| Antigravity | Available; native CLI policy | The CLI's `models` listing |
| Grok | Available; native CLI policy | The CLI's model listing, with auto-update disabled during the probe |
| OpenCode | Available; native CLI policy | The CLI's `models` listing |
| Muse | Available; native CLI policy | CLI default or a custom model ID; no machine-readable catalog is assumed |
| Kiro CLI | Detection only; terminal JSON completion/resume protocol remains unverified | Hidden from the task-capable CLI picker; installing Kiro IDE does not install Kiro CLI |

An available adapter still requires an installed CLI with the expected headless
protocol and a working account. The picker omits missing and unsupported CLIs;
it does not advertise a model as accessible merely because its name is listed.

Claude's fallback includes Opus 5.5, Sonnet 5.5 and Haiku 5.5 where the installed
CLI supports them, plus the `opus`, `sonnet`, `haiku` and `opusplan` aliases.
Explicit 5.5 choices require Claude Code 2.1.280, 2.1.284 and 2.1.293 respectively.
The names follow the [Claude Code model configuration documentation](https://code.claude.com/docs/en/model-config).
Aliases may resolve differently for different providers. These documented
choices are not an account entitlement check; the UI says actual availability
depends on the account and provider. WSL keeps its existing cached account
catalog and uses this Claude fallback only when that catalog is empty.

The page shares model answers for 30 seconds. Native discovery uses the bridge's
60-second inventory cache and coalesces simultaneous requests. Refresh models
bypasses that native inventory cache. The WSL model endpoint remains a read of
the coordinator's cached account catalog. Listing models does not send a model
inference request or modify an agent's settings.

## Execution and limits

The WSL coordinator starts a built-ins-only helper using Windows `node.exe`.
Windows resolves and launches its own CLI executable. Requests and prompts cross
the boundary as JSON/stdin data, not interpolated PowerShell or shell commands.
Windows PATH and the current user's usual installation directories are probed;
the Codex desktop app's common per-user `bin` locations are also checked.
Native `.exe` installations and recognized Codex/Claude/OpenCode npm Node shims
are supported. A shim is inspected and its known Node entrypoint is launched
directly; arbitrary batch wrappers are not executed. Grok and Muse receive
prompts through a private temporary file, removed when the worker finishes.

Only one task runs at a time. The helper requests cancellation after five
minutes, bounds protocol/output bytes, and uses Windows `taskkill /PID /T` on
the process it created for cancellation. It never kills by process name or
stops shared services such as an existing adb server. The coordinator retains
the slot until the helper closes. An unconfirmed lost helper blocks subsequent
tasks; verify Windows processes before restarting AgEnD. There is no automatic
retry for an uncertain execution.

One-off task status/output is held in memory (the newest 20 tasks); it is separate
from Fleet's durable instance deliveries. Restarting AgEnD loses one-off task
history; registered agents retain their runtime state and shared chat history.
This runtime has no device leases, serial-port broker, GUI automation or
automatic recovery of interrupted tasks. Incoming Fleet delegation is supported,
but a native CLI cannot initiate AgEnD tool calls until an outbound AgEnD MCP
transport is provided.
Tasks can use tools the native CLI can already access, within its own policy.
Only administrator dashboard sessions or the local operator header credential
can use the endpoints. Guest/read sessions and the managed public gateway are
refused. Cookie writes require the existing dashboard CSRF/origin checks.

## Validation

Account-free tests cover request/argv boundaries, repeated submission, competing
starts, cancellation during initialization, revoked authorization, provider
failure vs process exit, the public/guest/read/CSRF boundaries, common Fleet
creation and delivery, runtime-specific models, and history identity across
restarts. For example:

```sh
npx tsc --noEmit
npm run typecheck:tests
npx vitest run tests/windows-cli.test.ts tests/windows-cli-api.test.ts tests/windows-agents.test.ts tests/windows-agent-ui.test.ts tests/native-instance-api.test.ts tests/native-runtime-web-integration.test.ts tests/fleet-windows-runtime.test.ts tests/native-model-catalog.test.ts tests/runtime-model-picker.test.ts tests/unified-runtime-ui.test.ts tests/native-chat-history.test.ts
```

On a Windows host using Node 24's experimental global navigator, set
`NODE_OPTIONS=--no-experimental-global-navigator` before running the UI harness
tests. A restricted process sandbox can use Vitest's `--configLoader native
--pool threads` options. Some older disk-persistence tests assume POSIX file
modes, Linux owner paths or permission to create symbolic links; run those on
the supported Linux CI host rather than interpreting a Windows platform failure
as a native CLI acceptance result.

After building, a manual probe uses the real native installations without
sending a model task:

```sh
node scripts/smoke-windows-cli.mjs
```

An explicitly requested live check makes one read-only Codex request. It creates
a uniquely named temporary workspace and asks the CLI to read its random marker
and report the Windows platform. It requires both the marker and `Win32NT` in
the returned output. Run it on Windows or inside WSL:

```sh
node scripts/smoke-windows-cli.mjs --live
```

This native check is separate from CI and requires the operator's CLI account.
