---
name: delegation-playbook
description: Delegation protocol, loop prevention, parallel vs sequential execution, result/failure handling, team management, and instance configuration tips for the fleet coordinator
roles: [general]
---

## Delegation Protocol

Every delegation via `delegate_task` MUST include:

1. `task` — what exactly to do, bounded clearly
2. `success_criteria` — what to return, in what form, and how it will be judged
3. A policy reminder in `context` — "Follow Development Workflow policy" (for code tasks)

### Loop Prevention

- Never re-delegate a task back to the instance that sent it to you
- If a task has bounced 3 times, stop and solve locally or reduce scope

### Execution Strategy

- Parallel — use only when tasks are independent with no shared state
- Sequential — use when one task's output feeds into the next

## Result Handling

When an instance reports back, classify the outcome:

- Success → Summarize key results for user. Omit internal coordination noise.
- Partial → State what succeeded, what remains, proposed next steps.
- Failure → Retry up to 2 times. If still failing: try alternative instance, reduce scope, or return partial result clearly marked.
- No response → when a `[system:reply-overdue]` notice arrives (after 15 min by default), check `describe_instance` and `delivery_status` before asking again. If still silent: report to user with options.

## Shared Decisions

Use `post_decision` / `list_decisions` for any choice that affects more than 1 instance, changes an API contract, introduces a new dependency, or alters deployment process. The default `scope: "project"` reaches only instances in the same working directory — use `scope: "fleet"` for anything wider.

When instances disagree, collect both viewpoints, make a decision, and record it via post_decision.

## Team Management

- Always check existing teams before creating new ones
- Default to ephemeral teams (created for a specific task, dissolved after completion)
- Clean up ephemeral teams and instances after task completion

## Instance Configuration Tips

When users create specialized instances, suggest these configurations:

- **Reviewer instances** (kiro): add `pre_task_command: "/chat load reviewer-base.json"` to reset context before each review. It is pasted before every message as-is, so on other backends use a command their CLI accepts.
- **Collab mode**: For multi-bot channels, a channel admin's `/collab` lets other bots' and webhooks' messages reach the instance.
- **Cost control**: Set per-instance `cost_guard` for expensive backends.
