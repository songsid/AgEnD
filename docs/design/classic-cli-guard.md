# Restricted Classic room CLI guard

This is the A3 launch guard for Classic room contact authorizations. The contact
ticket evaluator and its origin proof remain separate. A tool menu is not an
authorization boundary, and the CLI guard is not OS isolation from processes
running under the same account.

## Launch and coverage contract

The server supplies a `ClassicRestrictedPlan`: room key, policy revision,
canonical AgEnD tool subset, public-read choice, and exact selected MCP tool
identities. The daemon accepts mode, room tools and the contact revision through
`setClassicRestriction({mode, roomTools, policyRevision})`;
`classicNativeGuard()` returns the shared `ContactGuardStatus`.

A plan change invalidates the running launch immediately. An old guard then
refuses input and tools, and reports restart-required. A new launch gets private,
immutable settings, hook, policy and receipt paths. Ready requires an actual
SessionStart receipt for that launch, matching its plan and file digests.
SessionStart itself cannot block input: UserPromptSubmit and PreToolUse enforce
the receipt and current-launch checks and use synchronous `onFailure: "block"`.
Missing scripts, crashes, invalid input and timeouts must refuse, not allow.

The contact revision also changes for grants and approvers. If the native tool
policy is identical, the daemon retains its frozen launch plan and receipt;
contact admission still uses the current server policy. A native policy change
cancels an in-progress launch before stale configuration or commands can be
applied. Switching a running room to legacy invalidates its old guard and shows
restart-required until a new launch applies that mode.

Local Linux x64 Claude in MCP mode is the initial covered path. Versions are added
only with real-binary isolated evidence. The documented failure-blocking minimum
is 2.1.295; the preceding 2.1.294 is a negative control. Unknown versions, other
backends, CLI mode and unproved operating systems report not-covered. Ordinary
Fleet launches and legacy rooms keep their existing behavior.

## Tool ceiling

The AgEnD MCP server uses only `CLASSIC_RESTRICTED_TOOLS` (or a narrower subset),
also enforced by the contact policy at call time. Public reading defaults on and
permits Claude's exact WebSearch and WebFetch tools, without granting Bash or
filesystem tools. All other built-ins, including agents and subagents, are
disabled and refused by the hook.
WebFetch additionally refuses explicit non-public targets: non-HTTP(S) schemes,
credentials in the URL, local/internal host forms, private/loopback/link-local
addresses, and conservative special-use IP ranges. URL parsing normalizes
decimal, hexadecimal and shortened IPv4 forms before checking them.

Strict MCP configuration excludes inherited servers. Only the bound AgEnD
server and administrator-selected, already-configured exact MCP identities are
admitted. Selecting one tool never admits the other tools on that server.
The initial resolver reads only the bounded top-level `mcpServers` object in
the selected owner's Claude config. It never reads repository `.mcp.json` or
project MCP definitions. It snapshots only explicitly selected stdio servers;
all such selections require the owner-account warning. Missing, ambiguous or
unsupported definitions remain unavailable and report not-covered while the
base public-read and AgEnD guard continues to work. HTTP/SSE definition discovery
is not covered in this slice.
Owner-account MCP tools require the contact UI's explicit cost and identity
warning. No wildcard, command fragment or app-supplied identity establishes
authority. A missing configured selection cannot become ready.

## Proof and limits

The URL check does not resolve or pin DNS, inspect redirects or connected
addresses, or constrain selected MCP tools' own network/data access. It does
not guarantee that internal services are unreachable through a public-looking
name or redirect. The CLI's transport checks still apply. The guard also does
not clear old transcripts, summaries or memory: previously learned information
can remain after switching a room. This slice adds no ordinary-worker action
gate and does not authorize a worker's later actions through contact approval.

Offline tests exercise the production plan, hook subprocess and stale receipts.
The manual rig uses real CLI versions, an isolated home, a private network
namespace and a local dummy API/MCP server. It proves loaded, allowed public
reads, exact room tools, denied built-ins/external tools, and broken-hook refusal.
It uses no live account or Fleet and does not alter an installed CLI.

Rollback removes the optional launch integration and returns explicit coverage
to not-covered. It must never leave a ready claim attached to an unguarded pane.
Inherited legacy tool inventories are not guessed: `impactComplete` is false
and the native `wouldDisable` inventory is unavailable. The contact service can
still show the exact AgEnD profile tools its own server ceiling removes.

References: [Claude hook failure contract](https://code.claude.com/docs/en/hooks#block-the-action-when-a-hook-fails),
[official 2.1.295 changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#21295),
and [Codex 0.170 configuration schema](https://github.com/openai/codex/blob/rust-v0.170.0/codex-rs/core/config.schema.json).
Literal IP classifications also follow conservative subsets of the
[IANA IPv4](https://www.iana.org/assignments/iana-ipv4-special-registry/) and
[IPv6 special-purpose registries](https://www.iana.org/assignments/iana-ipv6-special-registry/).
