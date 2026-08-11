---
name: worker-collaboration
description: Complete assigned fleet work as a worker, report the result to the assigning instance, and request missing information without taking over coordinator duties.
roles: [worker]
---

# Worker Collaboration

## Complete assigned work

- Treat the assignment as the full scope unless the sender explicitly expands it.
- Work without acknowledgment-only messages. Silence means the task is in progress.
- Do not call `delegate_task`; delegation and fleet orchestration belong to General.

## Request missing information

Use `request_information` only when a concrete missing fact blocks safe progress. Ask the assigning instance one focused question and preserve the task correlation ID when the tool supports it.

Do not resend after a timeout without checking delivery evidence. A timeout can mean the request was queued or delivered while the caller stopped waiting.

## Report the result

Call `report_result` exactly once when the assignment is complete or genuinely blocked. Send it to the assigning instance with the original correlation ID. Include:

- the conclusion or delivered artifact;
- material changes and file paths;
- tests or checks run and their results;
- remaining risk, blocker, or follow-up, if any.

Do not put user-facing results only in terminal text; the fleet report is the delivery channel.
