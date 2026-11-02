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

**Detection runs only when an administrator asks for it** (M-2239 P1-2): the
first time with **Detect Windows CLIs**, later with **Detect again**. It is
never started by a timer, by opening a page, by a model list (a GET) or by a
task. Detection starts each installed CLI once (`--version`, `--help`, and where
a CLI has them its sign-in status and model listing), always with that CLI's own
"do not update" switch:

| CLI | Update switch on every run AgEnD makes |
| --- | --- |
| Codex | `-c check_for_update_on_startup=false` |
| Claude Code | `DISABLE_AUTOUPDATER=1` |
| Grok | `--no-auto-update` |
| OpenCode | `OPENCODE_DISABLE_AUTOUPDATE=1` |
| Kiro CLI | `KIRO_NO_AUTO_UPDATE=1` |
| Muse | `MUSE_UPDATE_INTERVAL_SECONDS=31536000`; never started for detection (its version is read from `.muse-version` beside the launcher, #2078) |
| Antigravity | none documented: started only by Detect again or a task |

`NO_UPDATE_NOTIFIER=1` is set for all of them. The result is kept in the AgEnD
home (`windows-cli-inventory.json`) and survives a restart; every page and every
task reads it. A task starts no probe: it runs only a CLI that the last
detection found runnable (and, for read-only, able to enforce it), after
checking that its executable is still installed. Failed refreshes retain the
page's last successful inventory with a warning. Nothing is persisted to
browser storage.

One-off tasks in the Windows CLI settings section use an existing Windows
directory, such as `C:\Projects\example`. Registered agents may leave their
working directory empty, as described below.
Read-only is the default where available: Codex uses its native sandbox, while
Claude exposes Read, Glob and Grep and, for registered agents, scoped AgEnD
query tools. Other MCP servers are disabled in Claude's read-only mode. Claude's restriction
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
return through the same correlation ID. Compatible Codex and Claude Code agents
also receive scoped AgEnD MCP tools for each execution, as described below.
Attachments, terminal View/Log, raw terminal
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

For Windows, those model reads use the last saved detection. After installing,
updating or signing in to a CLI, explicitly run **Detect again** in Settings
before reloading the model picker. Reads and tasks do not start discovery.

| Native CLI | Task and conversation adapter | AgEnD tool calls | Model choices |
| --- | --- | --- | --- |
| Codex | Available; native read-only and workspace-write policies | Per-turn scope, when the installed CLI supports launch configuration | The native account's `models_cache.json`; no credential file is read for this list |
| Claude Code | Available; read-tool restriction or native CLI policy | Per-turn scope, when the installed CLI supports MCP configuration and tool filtering | Documented Claude choices, gated by installed CLI version |
| Antigravity | Available; native CLI policy | Not provided | The CLI's `models` listing |
| Grok | Available; native CLI policy | Not provided | The CLI's model listing at explicit detection, with auto-update disabled |
| OpenCode | Available; native CLI policy | Not provided | The CLI's `models` listing |
| Muse | Available; native CLI policy | Not provided | CLI default or a custom model ID; no machine-readable catalog is assumed |
| Kiro CLI | Detection only; terminal JSON completion/resume protocol remains unverified | Not provided | Hidden from the task-capable CLI picker; installing Kiro IDE does not install Kiro CLI |

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

The page shares model answers for 30 seconds. Native model lists come from the
last detection; reading them starts nothing, and Refresh models does not detect
again (use Detect again in Settings → Windows CLI). The WSL model endpoint remains a read of
the coordinator's cached account catalog. Listing models does not send a model
inference request or modify an agent's settings.

## AgEnD tools for registered Windows agents

Compatible Windows Codex and Claude Code agents can call AgEnD through an MCP
adapter during their current execution. Discovery reports this separately from
ordinary task support. The create and settings forms explain the available
scope only after the installed CLI confirms MCP support; an older inventory
without that capability does not imply support. Other native CLIs can still
receive Fleet tasks and return results through the existing delivery flow.
One-off tasks and the AI configuration draft helper do not receive an AgEnD
MCP capability.

The existing file-access selection also sets the maximum AgEnD tool scope:

- **Read only:** `list_instances`, `describe_instance`, `delivery_status`, and
  `task` with `list`, `get`, `mine` or `projects`. Task mutations and messages to
  other agents are refused.
- **Use native CLI permissions:** may additionally use `send_to_instance`,
  `delegate_task`, `request_information`, `report_result` and task mutations.
  The agent's existing tool profile and dashboard permissions still filter the
  actual menu and every call. Selecting this mode does not grant all Fleet tools
  or bypass the CLI's own approval policy.

The scope belongs to one registered instance, native profile, CLI and execution
request. The coordinator rechecks it for each tool call. Completion,
cancellation, pause, removal or fleet shutdown closes the capability; a change
that invalidates its instance/profile/CLI also refuses further calls. It expires
after at most six minutes. Tightening file access or tool permissions takes
effect during the turn; broadening file access does not broaden an already
issued read-only capability.

The Windows stdio adapter sends requests only to the coordinator's loopback
agent endpoint, using a dedicated per-turn credential. It does not use the
dashboard cookie, browser token or public gateway. Connection details live in a
temporary per-turn file that the worker removes when the execution ends; user
and project CLI configuration files are not rewritten, and the credential is
not placed in command arguments or environment variables.

Codex retains separately configured user MCP servers under its normal CLI
policy; the AgEnD query limit applies to this AgEnD adapter. Claude's read-only
launch loads only the scoped AgEnD server and its read tools. In native-permission
mode, Claude can retain its separately configured MCP servers under its own
policy.

The shared native execution slot still permits one task at a time. A Windows
agent that queues work for another Windows agent should finish its own turn so
the recipient can run; the native tool set has no blocking wait-for-peer tool.

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
automatic recovery of interrupted tasks. Incoming Fleet delegation is supported;
outbound AgEnD tool calls are limited to the compatible Codex and Claude Code
adapters and the scopes described above.
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
npx vitest run tests/windows-cli.test.ts tests/windows-cli-api.test.ts tests/windows-agents.test.ts tests/windows-agent-ui.test.ts tests/native-instance-api.test.ts tests/native-runtime-web-integration.test.ts tests/fleet-windows-runtime.test.ts tests/native-model-catalog.test.ts tests/runtime-model-picker.test.ts tests/unified-runtime-ui.test.ts tests/native-chat-history.test.ts tests/native-mcp-ui.test.ts
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
