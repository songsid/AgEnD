# Codex paste receipt ownership (#2301)

A fast Codex answer can scroll an unmarked paste out of the viewport before the submission judge reads it. A newest-cwd rollout is useful for progress, but cannot identify the pane that consumed a paste: two agents can share a cwd. The old result correctly stayed uncertain. Extra grace or another Enter cannot establish ownership.

## Attempt-local proof

AgEnD's private Codex config now puts `session-id` first and its configured Context variant second, preserving the remaining items' order. The user's shared config is untouched. The normal tmux width is 120 columns; the recorded View shows the full UUID, Context and model. At narrower widths, Codex can truncate Context or the UUID; those frames cannot bind a rollout. Lower-value items may be clipped first. An uneditable TOML config retains a launch warning and provides no guessed identity.

Before a durable raw paste, while the existing pane/write fences are held:

1. Read a full UUID and numeric Context from the current live composer/footer, with the existing dialog/disconnected vetoes. A UUID in history, header or quoted text is not a footer identity.
2. Find exactly one active rollout for that UUID with an async streamed directory walk (no synchronous shared index). Validate its first complete metadata record: actual `id`, canonical cwd, root source (`cli` or the recorded historical/default `vscode`), no parent thread, and absent or `user` thread source. Reject unreadable/incomplete listings, ambiguous files, symlink leaves and unsupported metadata.
3. Bind device/inode, exact metadata bytes and a complete EOF boundary. A pre-existing or partial user record cannot become this paste's proof.
4. Read forward with the existing exact plain-user-text matcher and bounded incremental reader (256 KiB/look, 250 ms logical deadline, one physical look). Check the opened descriptor as well as the pathname around reads. Metadata validation reads at most 64 KiB plus one EOF byte and has a 250 ms logical deadline; validation is single-flight. A timed-out physical read drains without authorizing a result or starting another validation.
5. Recheck the live pane UUID and original tmux/window, boot, spawn, launch attempt, launch fence and caller fence after asynchronous work. Session switch, file replacement, capture loss, dialog, cancellation or launch change retires this attempt's lease permanently. A reader-observed identity/read loss directly retires the same lease used by both normal confirmation and fallback; restoring the original inode before the next validation cannot conceal that observation. A late read or restored UUID/file cannot revive it. Settlement checks again after its final await.

Only the acquired runtime lease enables raw Codex transcript proof. Codex is **not** added to the global raw-text allowlist. The general cwd progress source, resume planner and `getSessionId() === null` are unchanged. A saved delivery checkpoint never recreates a lease after daemon restart. Existing direct pane proof is preserved when no lease was acquired; an acquired lease that becomes invalid cannot be bypassed by old pane evidence.

## Bounds and limits

Discovery has a 250 ms logical deadline, at most20,000 entries,512 directories and depth8; it yields every64 entries. Any unreadable directory, symlink, depth/count cap or incomplete enumeration refuses uniqueness. Timed-out discovery cancels further work and closes its owned directory after a pending operation returns. Only one physical acquisition per sessions path may drain at a time. Local raw Codex skips the diagnostic newest-cwd checkpoint entirely, using only the exact-UUID bounded acquisition; ordinary and native Runtime checkpoint paths are preserved.

No extra paste, recovery Enter or automatic replay is added. The first unwritten session, missing rollout, truncated/unknown footer, unsupported metadata and lost ownership may still produce uncertainty. Exact text proves consumption, not that the model finished or replied. CLI timestamps are not ownership evidence. This is the ordinary tmux path; it is not a new native-Runtime receipt mechanism or a Windows acceptance claim.

The offline private-tmux replay uses recorded pinned Codex 0.167.0 mock-only frames and a real Daemon/Outbox. It keeps the old baseline uncertain, confirms the owned case, and keeps switched/replaced/narrow cases uncertain, each with one paste and one initial Enter. See `tests/fixtures/codex-pane-owner-2301/README.md` and `docs/screenshots/codex-pane-owner-2301/README.md` for provenance and exact receipts.

Rollback: revert the patch; existing uncertain/no-resend behavior returns. No storage schema or user shared-config migration is needed.

## Upstream reference

Public source checked 2026-11-11, Codex `rust-v0.167.0`, commit `086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a`:

- [Status item](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/tui/src/bottom_pane/status_line_setup.rs): full current thread UUID, `session-id` alias of `thread-id`.
- [Rendered value/order](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/tui/src/chatwidget/status_surfaces.rs): current thread id and configured item order.
- [Footer truncation](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/tui/src/bottom_pane/footer/footer_content.rs): available-width truncation is not proof of a partial UUID.
- [Metadata](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/protocol/src/protocol.rs): `id` is the actual thread, `session_id` can denote the root; source and parent/thread-source are separate.
