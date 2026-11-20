# Managed Claude credentials

Approved design, implemented in small development-only slices. Storage and authenticated API are followed by the host launch integration below. The dashboard paste selector is a separate slice and is not offered yet.

## Storage boundary

`ClaudeCredentialVault` keeps AES-256-GCM ciphertext in `credential-vault/claude.sqlite`, with a separate random 32-byte key in `credential-keys/claude.key` (the owner-only file fallback). Directories are 0700 and files 0600. Symlinks, hard-linked files, changed database identity, permissive modes, lost keys and failed authentication are refused. There is no plaintext fallback to SecretStore or `.env`. An injectable key provider leaves room for an OS credential-store implementation; the current production fallback is a file, not hardware protection. Backups of ciphertext and the key must be managed separately.

AAD binds backend, opaque record id, profile, credential kind and revision. SQLite's immediate transaction commits the sealed value and its metadata-only audit event together. Replacing uses revision CAS. Removal keeps a tombstone and monotonically increasing revision; an old page cannot recreate revision zero. Audit retention is 1,000 rows. The key is checked before opening an existing vault and is never silently regenerated for it. The internal launch/helper port requires the record id and revision and returns a Buffer the caller must zero.

Same-OS-user processes can still read the key, call the eventual helper, or inspect a running process. This is encryption at rest, not isolation from agents sharing that OS user.

## Host API

`/ui/claude-credentials`:

- GET, optional `?profile=<name>`: metadata only (id, profile, revision, kind, state, update time). An omitted profile means the default connection.
- PUT `{profile, revision, kind, value}`: `api-key` or `setup-token`; strict, bounded single-line input. Save performs no provider/model request and returns `saved-unverified`.
- DELETE `{profile, revision, confirm:true}`: removes the saved secret, not the profile or conversation, returning `not-connected`.

Every operation requires a direct loopback request with no public-gateway provenance or forwarding headers, an admin session and the existing current verified-actor proof. Header/MCP tokens, guest/read sessions and public links (even a verified public admin) are refused. Writes retain the ordinary session/CSRF gate and recheck session/actor after the bounded body read, immediately before the synchronous commit. Secret values are never returned or logged; errors expose fixed categories only. Set/replace/remove commit audit atomically; refused attempts record only fixed outcome, verified actor if available, and action. The audit never stores request bodies or secret fragments.

A named profile must already exist and be owner-controlled. This storage slice refuses writes while the profile has configured/live consumers, an uncertain consumer, concurrent login, install or keep-alive. Profile deletion is refused until its managed secret is removed, preventing a recreated name from adopting an old secret. The later lifecycle slice will add the approved explicit confirmation/idle restart flow instead of changing a live CLI's credentials underneath it.

## Following slices

1. API key through a private `apiKeyHelper` broker; setup-token through a launcher that passes `CLAUDE_CODE_OAUTH_TOKEN` only to the child, clearing competing inherited sources and refusing fallback.
2. Approved dashboard method/status/replace/remove views and Needs you, with local+verified errors and localized help links. Real-app captures require user review before merge.
3. English and zh-TW website help at `/docs/claude-credentials/` and `/zh-tw/docs/claude-credentials/`. The website PR targets main (the deploying branch) and stays on HOLD until user review, a successful local website build and M-3419 shipping in a beta.

Existing subscription login remains unchanged by this first slice. No real credential or paid/model request is used in tests. Rollback removes the new API composition while preserving the encrypted files and separate key; do not delete either as a rollback step. Earlier binaries ignore this separate store.

## Host launch integration

The daemon resolves an opaque id/revision/kind from its own state directory and selected credential profile at launch. A removed record is a deliberate disconnected state, never permission to use an ambient login. Cleanup does not need to decrypt the vault, so removing or losing a credential does not prevent stopping its daemon.

The backend writes a private launch reference and `apiKeyHelper` command containing references only. The standalone helper/broker returns the API key on Claude's private stdout pipe; it keeps the Buffer alive until the pipe callback confirms receipt, then zeroes it. The setup-token launcher reads the encrypted value and places `CLAUDE_CODE_OAUTH_TOKEN` only in the Claude child environment (including its source-only auth-status subprocess), not the Fleet environment, shell/tmux command, settings or launch reference. The parent process environment is not mutated. Same-user processes can still inspect runtime secrets; this is not isolation.

Competing inherited API/auth token, provider URL/header, Anthropic profile/config selectors and provider flags are cleared. Managed credentials bypass the legacy ambient-key command insertion and key-tail approval cache. Profile directory, resume/model/effort and additive instructions remain selected as before. A covered Classic guard retains its settings, strict MCP arguments and receipt requirement; the auth-status probe does not establish native guard readiness.

The launcher asks the CLI's local `auth status --json` for the expected source class (`api_key_helper`/`apiKeyHelper` or `oauth_token`) on first-party API. That is not provider validation. It refuses a different/unknown source, stale id/revision, changed source inputs, a mismatched helper command or a detected auth-setting conflict. It rechecks revision and source inputs after that bounded probe. API-key retrieval also rechecks accessible settings. File reads, policy-directory enumeration, total parsed bytes and subprocess time/output are bounded.

Known file-based policy fragments and non-empty remote policy caches can override a command-line helper; these are checked/refused rather than bypassed. Policy programs and forced login/gateway selectors are refused. Only ordinary local profiles are supported. Organization-managed Claude settings are unsupported; this inventory is not effective-policy attestation for opaque MDM, Windows Registry or live server-managed policy. A CLI source-class report does not identify the secret value an opaque organization policy may supply. Do not describe that environment as validated by these tests or claim that organization policy can be overridden. The implementation never changes those policies. See [managed sources](https://code.claude.com/docs/en/managed-settings) and [server-managed settings](https://code.claude.com/docs/en/server-managed-settings).

Evidence is Linux fake-CLI process isolation plus Claude 2.1.329 source-only commands in a network namespace with empty synthetic homes. No vendor credential/model request was used. Other native platforms or policy mechanisms were not exercised. The UI slice still needs explicit subscription-source transition, used-profile restart confirmation, metadata/status and removal behavior; a normal successful model request must not be inferred from source selection.

Rollback after launch integration: stop/disable consumers of managed profiles before using a binary that does not recognize the managed store. Preserve vault and key. Choose an explicit supported credential profile before resuming those consumers; simply stripping the wrapper could revive an older ambient login. Earlier storage-only rollback instructions do not authorize that fallback.
