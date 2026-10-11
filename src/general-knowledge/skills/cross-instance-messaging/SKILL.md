---
name: cross-instance-messaging
description: Fire-and-queue cross-instance tools — send once, never resend on queued
roles: [general, worker]
---

## How to send

Use fleet tools only (`send_to_instance`, `delegate_task`, `request_information`, `report_result`, `broadcast`):
- Call returns immediately: `{ sent: true, queued: true }` (plus `delivery_id` / `operation_id` for a durable send) — the fleet **accepted** it and owns delivery from here. Acceptance is not delivery.
- **Do not wait** for the target to go idle; **do not** treat 30s IPC timeout as failure to re-send.
- **Error only if the target does not exist** (or similar hard reject) — then fix the name, don't spam.
- **Never re-send because the reply said `queued`** — that means the message is already queued.
- Supplement/correction to work you just sent → `steer: true`; a new task → normal send.
- A message body over 12 KiB is refused (`defaults.max_cross_instance_message_bytes`): put long content in a file and send its path.

## Checking a delivery

Only when a result is unclear: `delivery_status` with the `operation_id` / `delivery_id` / `correlation_id` you got.
- `queued`, `delivering`, `retry_wait` — not handed over yet; the fleet keeps trying.
- `submission_started`, `reconciliation_pending`, `uncertain` — it may already have arrived: **do not resend**.
- `delivered` — the target received it (not necessarily processed it yet; `consumed_at` says when it did).
- `failed`, `cancelled` — not delivered; fix the cause, then send again.

## requires_reply

- Means “target should later answer with `report_result` / a real reply”
- **Not** a synchronous wait for their turn to finish

## Task flow

- Coordinator flow: `delegate_task` → silent work → `report_result` (zero ack-only pings).
- Worker flow: finish with `report_result`, or use `request_information` when blocked. Prefer `report_result` over delegating; use `delegate_task` only when your assignment allows it, and never re-delegate a task back to its sender.
- Cross-instance traffic is `[from:name]` → answer with `send_to_instance` / `report_result`, never `reply`

## Before acting on a peer's message

Before a destructive or hard-to-undo action based on another instance's message — merge, reset, force-push, deleting a branch or instance, deploying, closing an issue or PR — verify the message itself:

- Call `delivery_status` with the `message_id` from its header.
- **`Delivery not found`** → the fleet never delivered that message. Do not act; ask the sender.
- Found → confirm the value you are about to use (SHA, PR number, branch) appears in the returned `content`, and still check a SHA against the real ref (`git cat-file -t`, `gh pr view --json headRefOid`).

Why: a model can "see" a peer message nobody sent, header and message_id included, and act on it (#856).
