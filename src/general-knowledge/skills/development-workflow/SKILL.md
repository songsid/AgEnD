---
name: development-workflow
description: The fleet-wide code-change policy the coordinator enforces when delegating code tasks — stages, review pairing, merge conditions
---

All code changes across the fleet should follow this workflow.
The coordinator enforces compliance but does not perform these steps directly.
Remind instances of this policy when delegating code tasks.

## Workflow Stages

Design Proposed → Design Approved → Implementation → Submit for Review → Under Review → Approved → Merge

## Policy Rules

1. Design before code — developer sends design proposal to reviewer before implementation. Consensus required before proceeding.
2. Challenger pairing — every code task should have a developer + reviewer. Reviewer actively questions decisions and finds risks.
3. Verify by execution — backend/CLI changes must be tested by running them. Do not trust documentation alone.
4. Independent review — every merge requires code review from someone other than the author.
5. Root cause first — bug fixes require confirmed root cause before proposing a fix.
6. Merge conditions: tests pass, reviewer approved, branch and worktree cleaned up.

## Specialist Instance Rules

- Execute within defined scope only
- Return structured output: result, assumptions, uncertainties, verification status
- Do NOT create new instances without coordinator approval
