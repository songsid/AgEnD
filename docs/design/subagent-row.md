# Read-only child-Agent observations

M-2745 / approved M-2739. The first slice is a **collapsed disclosure in the chat progress dock**, labelled with the parent task (or its proven parent-turn start time when the CLI omitted the task text). Chat deliveries have no exact CLI turn anchor, so the disclosure is never attached to an arbitrary reply and creates no chat-ledger entry. Under-reply placement needs a future exact session/turn anchor.

## Evidence and limits

The fixture source is research commit `6380b4cec734bc1e28051f849afd04c948942c44`, `docs/research/subagent-visibility`: real audited Claude Code 2.1.319 and Codex 0.167.0, private mock APIs and tmux, scratch homes, no account, only loopback in an unprivileged network namespace. Fixtures here contain only selected sanitized structured records. No CLI or model was started for this implementation's browser acceptance.

* Claude: a successful background `Agent` call/result in the exact parent session, prompt and assistant call; child sidechain records and matching meta; CLI-authored task-notification with the exact child/call IDs, terminal status and duration. A `finished` sidecar or the parent's prose alone is not a completion.
* Codex: successful `multi_agent_v1.spawn_agent` in a known parent turn; child metadata must bind both session and explicit `parent_thread_id`, cwd and first-level source; matching child `task_started` attribution and `task_complete`. The existing main-transcript subagent exclusion is untouched.
* Completed rows show bounded returned text and CLI duration (wall/turn duration, not CPU time). Fresh open records show elapsed wall time. Missing, partial, stale, incompatible or disconnected evidence is **Unconfirmed / 待確認**, without a result or a completion timer.
* Only these captured schemas and first-level children are supported. Legacy Task spellings, synchronous Agent responses, independent `create_thread` tasks, arbitrary-depth trees, resumed child turns without a new proven launch, and native/paired Windows records are not inferred. A bounded parent window can omit an old launch/turn boundary; that work is unavailable instead of guessed. Unreadable/over-window parents with no proved child work remain hidden, while previously observed work becomes unconfirmed. No model request is made to fill a gap.

## Ownership and resource boundaries

A separate optional reader follows only the current daemon's selected parent transcript, selected credential-profile home, exact session/cwd and interaction owner. It never selects a latest same-cwd file. It does not enter TranscriptMonitor, delivery, readiness, Needs you, supervision or the chat ledger. No child commands, approval, cancel or continue actions exist.

Files must be regular, below the selected canonical home and free of descendant symlinks; fd/path identity and size/mtime/ctime are checked around the bounded read. Parent reads at most 2 MiB (first complete metadata record plus a recent tail starting at a newline for long sessions), child 512 KiB, meta 32 KiB; complete JSONL only, 20,000 records, 128,000 characters per line. Claude paths are derived from validated IDs, never an output_file. Codex scans only the parent day and next day, at most 256 directory entries each; duplicate child paths or exhausted discovery produce unknown rows. Only 16 recent proved launch edges are projected; text fields are capped and known secret shapes masked. Reasoning, arbitrary tool bodies, system context and private filesystem paths are not projected.

There are two **shared physical reservations**, acquired before I/O and held until read, directory iteration and awaited file cleanup actually settle. A 1-second logical observation deadline does not release physical capacity or construct replacement readers. Requests for the same source coalesce; results cache for 2 seconds, at most 16 sources. Source identity is checked after awaits. The browser polls at most once per 6 seconds with one request in flight; a failed read removes completion claims. Launch/source changes retire previous continuations.

`GET /ui/subagents` is local-dashboard **admin-only** (admin session or header token), rechecked after the asynchronous read. It is absent from Hub, guest and public-gateway route manifests, public View and read-session UI. The shell's optional marker controls display, never authorization. Passive polling does not extend session idle authorization. Changing ownership makes cached proof ineligible.

## UI and compatibility

`docs/design/ui-style-guide.md` applies. Existing tokens, native details/summary, 44px summary target, neutral treatment and existing Retry component. The bounded expanded body scrolls independently so the composer stays available. Progress lives outside the message ledger and explicitly says a child's report is not the main Agent's final answer.

No new static import crosses an existing shared-module boundary. The chat lazy-loads its optional module only on an offered admin shell. An old panel ignores it; an old server's 404 or missing module preserves chat; the module owns its stylesheet so cached app.css is safe. EN/zh-TW, desktop/phone, light/dark and these SKEW combinations are exercised by `scripts/manual/subagent-row/accept.mts`.

Rollback: revert this feature's commits. There is no persisted state, config/schema migration, lifecycle mutation or child authority to undo. The row is a best-effort observation, not proof that a child result is correct or that arbitrary CLI versions are supported.
