# Managed Claude credentials

Approved design, implemented in small development-only slices. This first slice adds private storage and an authenticated storage API; it does not switch a CLI's credential source or add a dashboard selector yet.

## Storage boundary

`ClaudeCredentialVault` keeps AES-256-GCM ciphertext in `credential-vault/claude.sqlite`, with a separate random 32-byte key in `credential-keys/claude.key` (the owner-only file fallback). Directories are 0700 and files 0600. Symlinks, hard-linked files, changed database identity, permissive modes, lost keys and failed authentication are refused. There is no plaintext fallback to SecretStore or `.env`. An injectable key provider leaves room for an OS credential-store implementation; the current production fallback is a file, not hardware protection. Backups of ciphertext and the key must be managed separately.

AAD binds backend, opaque record id, profile, credential kind and revision. SQLite's immediate transaction commits the sealed value and its metadata-only audit event together. Replacing uses revision CAS. Removal keeps a tombstone and monotonically increasing revision; an old page cannot recreate revision zero. Audit retention is 1,000 rows. The key is checked before opening an existing vault and is never silently regenerated for it. The internal launch/helper port requires the record id and revision and returns a Buffer the caller must zero.

Same-OS-user processes can still read the key, call the eventual helper, or inspect a running process. This is encryption at rest, not isolation from agents sharing that OS user.

## Host API

`/ui/accounts/claude-code/credential`:

- GET, optional `?profile=<name>`: metadata only (id, profile, revision, kind, state, update time). An omitted profile means the default connection.
- PUT `{profile, revision, kind, value}`: `api-key` or `setup-token`; strict, bounded single-line input. Save performs no provider/model request and returns `saved-unverified`.
- DELETE `{profile, revision, confirm:true}`: removes the saved secret, not the profile or conversation, returning `not-connected`.

Every operation requires a direct loopback request with no public-gateway provenance or forwarding headers, an admin session and the existing current verified-actor proof. Header/MCP tokens, guest/read sessions and public links (even a verified public admin) are refused. Writes retain the ordinary session/CSRF gate and recheck session/actor after the bounded body read, immediately before the synchronous commit. Secret values are never returned or logged; errors expose fixed categories only. Set/replace/remove commit audit atomically; refused attempts record only fixed outcome, verified actor if available, and action. The audit never stores request bodies or secret fragments.

A named profile must already exist and be owner-controlled. This storage slice refuses writes while the profile has configured/live consumers, an uncertain consumer, concurrent login, install or keep-alive. Profile deletion is refused until its managed secret is removed, preventing a recreated name from adopting an old secret. The later lifecycle slice will add the approved explicit confirmation/idle restart flow instead of changing a live CLI's credentials underneath it.

## Following slices

1. API key through a private `apiKeyHelper` broker; setup-token through a launcher that passes `CLAUDE_CODE_OAUTH_TOKEN` only to the child, clearing competing inherited sources and refusing fallback.
2. Approved dashboard method/status/replace/remove views and Needs you, with local+verified errors and localized help links. Real-app captures require user review before merge.
3. English and zh-TW website help at `/docs/claude-credentials/` and `/zh-tw/docs/claude-credentials/`. The website PR must stay on HOLD until user review and a successful local website build because merge deploys it.

Existing subscription login remains unchanged by this first slice. No real credential or paid/model request is used in tests. Rollback removes the new API composition while preserving the encrypted files and separate key; do not delete either as a rollback step. Earlier binaries ignore this separate store.
