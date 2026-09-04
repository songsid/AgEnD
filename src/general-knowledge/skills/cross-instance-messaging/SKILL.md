---
name: cross-instance-messaging
description: Fire-and-queue cross-instance tools — send once, never resend on queued
roles: [general, worker]
---

## How to send

Use fleet tools only (`send_to_instance`, `delegate_task`, `request_information`, `report_result`, `broadcast`):
- Call returns immediately: `{ sent: true, queued: true }` — success, fleet owns delivery.
- **Do not wait** for the target to go idle; **do not** treat 30s IPC timeout as failure to re-send.
- **Error only if the target does not exist** (or similar hard reject) — then fix the name, don't spam.
- **Never re-send because the reply said `queued`** — that means the message is already queued.
- Supplement/correction to work you just sent → `steer: true`; a new task → normal send.

## requires_reply

- Means “target should later answer with `report_result` / a real reply”
- **Not** a synchronous wait for their turn to finish

## Task flow

- Coordinator flow: `delegate_task` → silent work → `report_result` (zero ack-only pings).
- Worker flow: finish with `report_result`, or use `request_information` when blocked. A normal worker must not call `delegate_task` or re-delegate work.
- Cross-instance traffic is `[from:name]` → answer with `send_to_instance` / `report_result`, never `reply`
