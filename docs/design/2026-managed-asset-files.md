# Managed working directories and appearance files (#2026)

## Inventory

This is a source inventory; no live instance, credential, session or configuration files were inspected.

| Producer | Working directory | Source |
| --- | --- | --- |
| Auto-created General | `<state>/general`, or `general-<adapterId>` with several adapters | `fleet-manager.ts`, General creation |
| Existing General | Its configured directory; adoption does not relocate it | `fleet-manager.ts`, General adoption |
| Fleet instance without a directory | `<state>/workspaces/<instance>` | `config.ts`, instance defaults |
| `create_instance` without a directory | `<state>/workspaces/<instance>` | `instance-lifecycle.ts`, create |
| ClassicBot | `<state>/workspaces/<instance>` | `fleet-manager.ts`, startClassicInstance |
| Explicit create, settings, setup, quickstart | Configured directory, possibly in state | `instance-lifecycle.ts`, `settings-effect.ts`, `setup-wizard.ts`, `quickstart-api.ts` |
| Template | Explicit directory passed to create; branch mode uses a sibling/custom worktree | `outbound-handlers.ts`, template deployment |
| Team | Membership only; no separate directory allocation | `outbound-handlers.ts`, team creation |
| Backend cwd resolution | Antigravity creates and returns the same configured directory | `backend/antigravity.ts` |

General's directory is not a clean asset store. It contains generated instruction files (`CLAUDE.md`, `AGENTS.md` or backend equivalents), steering and role skill trees under `.claude`, `.agents`, `.kiro` and `.grok`. Kiro creates `.kiro/agents/*.json` and `.kiro/settings/mcp.json`; Grok creates `.mcp.json`; OpenCode creates `opencode.json` with MCP environment configuration. Local backend configuration can contain secrets even when its usual generated contents do not.

Claude's AgEnD-generated settings and MCP files are under `instances/<name>`, not the working directory. Session IDs, agent tokens and runtime state also live there. Credential profiles, Codex homes (`cx/`), Kiro homes (`kiro-v3/`), root `.env`, databases and web tokens are separate protected state. A configured directory must not turn these locations into an asset area.

Classic workspaces also contain `chat-logs/`, `web-chat.json`, `web-files/` and uploaded `inbox/` files. General's inbound attachments are delivered to `workspaces/<instance>/inbox`, even when its actual working directory is elsewhere. Appearance previews use `.agend/appearance/`; exported mods use `.agend/mods/`. Repository checkout ownership records belong to instance state.

Manually configured directories can be shared or nested. A distinct instance name alone does not prove exclusive ownership. All filesystem scope checks remain convenience and accidental-disclosure protections for same-OS-user agents; CLI identity is controlled by that shell and is not an isolation boundary between mutually untrusted agents.

## Admitted areas

Effective fleet directories merge `defaults.working_directory` with each instance override, falling back to the conventional path only when the merged value is falsy. This same side-effect-free resolution applies to the caller and every peer; dynamic Classic instances absent from the fleet roster do not inherit that field.

The directory must match the caller's effective `fleet.yaml` record (or the exact conventional `workspaces/<caller>` default). The daemon additionally supplies its launch-config directory; disagreement refuses. The shell's current directory constrains access further but never supplies ownership. An unreadable or malformed fleet roster refuses in-state access. No fleet loader with directory-creation side effects runs here.

- Classic/standard own workspaces keep ordinary-file support, with new sensitive-path denial.
- Other configured in-state directories (including a configured project below its own conventional workspace) admit only `web-assets/`, `web-effects/`, `.agend/appearance/` and `.agend/mods/`.
- The last two are the existing generated preview/export paths. They do not exempt other `.agend` files.
- Other project directories retain their existing behavior.

General's mixed configuration is the reason for requiring staging there. Nothing is moved or migrated. Agents copy intended assets into a staging area. The policy was approved before implementation; Classic compatibility does not imply that all managed directories are clean.

The managed root and its parents must resolve exactly to the configured expected path, after canonicalizing the state-root alias. Another instance's configured directory may neither overlap nor alias this root. The state root, `workspaces` container, credential/runtime/control directories and host appearance stores never qualify as a new managed root. A managed path escaping state through a replaced parent remains refused; it cannot become an ordinary external project by resolving elsewhere.

Sensitive names are refused at every depth, including inside staging: hidden configuration (except the two generated output paths), `.env`, database files and sidecars/backups, instruction and backend configuration, credentials, sessions, upload/history directories and host state filenames. This is a bounded accidental-disclosure policy, not a claim to recognize arbitrary secret bytes renamed as an image. In-state reads also require a single-link regular file, so a hardlink cannot bypass the realpath boundary. Copying a file is an explicit agent action; same-user shell access remains outside this isolation model.

Additional reserved state stores from the source inventory: `kiro-identity`, `operator`, `model-catalog`, `profiles`, `preview-tunnel`, `bin`, `web-effects`, `web-mods`, `web-themes`, `web-owner-css`, `cards`, `avatars`, `cache` and `web-files`. Root records include fleet/classic YAML, web session/device/preference/effect records, tokens, scheduler/profile/event/outbox databases, identity ledgers and runtime/update controls. Their names do not become uploadable simply by placing them under staging.

## Verification and rollback

Tests use private filesystem fixtures, daemon handlers and a local CLI transport stub. They cover relative/absolute General reads, adapter General, arbitrary configured managed cwd, ordinary Classic assets, sensitive names, generated output/readback, shared/nested/aliased roots, missing and malformed config, root/parent/staging/file symlinks, hardlinks and external-project controls. No live fleet, account, service or credential files are used.

There is no migration or background action. A normal revert restores the earlier restrictive behavior; staged files remain ordinary user files. Mutable paths owned by the same OS user are not a sandbox against that user or a malicious shell.
