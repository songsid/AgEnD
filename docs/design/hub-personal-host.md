# Personal question host (M-3224)

The standard HTTP migration registry now includes `s3-personal-agents`, after the retained HTTP/room schemas.
The sealed factory mounts one private Runtime coordinator and the owner/turn adapters only when that component is
in its actual plan; injected older HTTP entries still omit them. Personal admission remains off by default. The
registration test uses the real factory, HTTP, SQLite and Runtime; only installer archive metadata is substituted.

The authorized x64 packet in `docs/evidence/hub-personal-host-m3224/windows-x64/` proves one real Claude Code answer
on Windows 11 Enterprise x64 10.0.26100.9711. Codex on that host remains unavailable because its PowerShell 7.4.22
cannot initialize filesystem commands with root denied. A root-read diagnostic also read an owned outside-folder
canary, so it is not a permitted repair. #4071's shell-read check remains in force. Availability is always local
and per CLI, never inferred from an OS version. No further model turn was run after the one authorized answer.

The Hub owns a separate Runtime coordinator under `hub/personal-runtime`. The Hub HTTPS listener serves only
Runtime enrollment hello/enroll, credential rotation, the authenticated WSS connect path, and the immutable installer
files. Ordinary code pairing and claim are absent. Browser cookies/origins and gateway requests cannot pair a Runtime.
No ordinary Fleet, panes, account-management host, MCP handler or updater is composed.

## Owner and administrator API

All browser routes reject query parameters; writes require the current session's CSRF. Identity is taken from the
signed-in company session. Administrator operations use the mounted `hub.admin` authority.

| Route | Result |
| --- | --- |
| GET/PUT `/hub/v1/admin/personal-agents` | `{enabled,people,teams}`; PUT takes that same strict shape |
| GET `/hub/v1/me/personal-agent` | `{enabled,canAdd,agent,computer}`; only the current owner's records |
| PUT `/hub/v1/me/personal-agent` | `{name,description,cli,model?,ifRevision}` → `{exposure}` |
| DELETE `/hub/v1/me/personal-agent` | `{}` → `{disconnected:true}` |
| POST `/hub/v1/me/personal-agent/enrollment` | `{}` → one-time token/fingerprint/expiry, plus installer hashes and `server` when the production installer is composed |

`agent` is null or `{id,exposureId,name,description,cli,model,revision,state}`. `computer` is null or
`{id,name,connected,compatible,folder,clis}`. Each CLI keeps its existing bounded inventory fields plus `available`
and `personalStatus`. Availability comes from that computer's actual local enforcement check and sign-in, never
from a Windows version allowlist. The personal source requires a Windows computer. `agentKind: "personal"` is
additive on browser room views/members; it is not added to the existing strict Fleet member-list response.

A replacement binds the latest consumed owner enrollment, freezes the previous publication and retires older
credentials. Disconnect first records revoked enrollments, removes the binding and freezes publication in the same
audited SQL transaction. Runtime credential retirement follows the commit and is retried from those retained facts.
It cannot restore the old binding after restart. The definition/history remain for a later owner setup.

## Turns

Direct questions use the existing grant, people and room audience proof. Explicit human group mentions use the
existing room audience, member floor and source proof. Verified person-via-agent posts count as people; autonomous
Fleet-agent mentions are refused before creating any target delivery, placeholder, job or question statistic.
Personal agents are excluded from @all. Personal answer text never starts another agent ask.

A durable job is claimed before sending the exact job UUID to the Runtime. One computer runs one question at a time.
A command ACK is running work, not answer evidence. Only a completed physical outcome with a successful final answer
can disclose; owner/source/revision/computer-generation and conversation authority are checked again then. Disabling
personal agents cancels a running turn. The five-minute deadline cancels unresolved work, queued work expires after
24 hours, and startup marks an interrupted claimed job failed rather than replaying it. Offline presence uses the
existing `later` (answers when connected) word; a running job is `working`.

## Source-agent mention feedback

The Hub-only `room-mention-feedback-v1` offer is sent only to a peer whose existing `fleet-update-v1` hello proves
32-name welcome support. No new unconditional member hello name is added. The member composes the notification
receiver before opting in with `mentionFeedback:true` on a post or answer. Without both checks, the original strict
post result/answer ACK shape is unchanged.

Optional `mentionRefusals` is `{id,refusals:[{code:"personal-people-only",name}]}` (1–64 bounded entries). The opt-in
is diagnostic and excluded from the frozen operation/answer digest. Feedback has audit-bound encrypted content on
the Hub, and a separate encrypted input journal on the Fleet. Answer feedback maps only the exact retained question
and answer; post feedback maps only the original frozen operation. A failed journal commit leaves the original ACK
retryable. Input intent precedes ordinary no-reply agent delivery; interrupted input is held, never replayed. It
cannot reopen an answered operation or change answer text. The notification uses the agreed EN/zh-TW refusal.

## Install and rollback

The dedicated static installer creates the empty `Hub agent` folder and a per-Hub personal profile, uses a separate
`agend-personal-runtime` installation, leaves PATH unchanged and restarts only that personal profile. Ordinary Runtime
installer behavior and its existing shim/batch bytes remain unchanged. Phase 1 has no managed updater.

Before registration, take the complete matching backup described in `hub-personal-owner-model.md`. Functional
rollback disables personal admission while retaining a schema-compatible binary and journals. Do not downgrade an
already populated personal schema by deleting migration records or fabricating Fleet metadata.
