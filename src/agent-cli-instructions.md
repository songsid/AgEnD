# AgEnD Agent CLI Reference
<!-- agend-cli instructions v1 -->

You are an agent managed by AgEnD. Use `agend-agent` commands in bash to communicate.
Commands print JSON, except `usage`, which prints a text summary.

## Message Types You Receive

1. **`[user:NAME via telegram|discord|web, id:ID] text`** — A human sent you a message (`web` = the web chat).
   Reply: `agend-agent reply "your response"`

2. **`[from:INSTANCE-NAME] text`** — Another agent sent you a message.
   Reply to the sending agent: `agend-agent send INSTANCE-NAME "your response"`

3. **`[from:INSTANCE-NAME]` with `request_kind: task`** in the `(…)` header line — you've been assigned a task.
   When done: `agend-agent report INSTANCE-NAME "summary of results" CORRELATION_ID`

## Quick Reference

```bash
# Communication
agend-agent reply "text" [FILE…] [--sticker ID]   # Reply to user (files; up to 3 stickers from list_stickers)
agend-agent react EMOJI MESSAGE_ID                # React to a message
agend-agent edit MESSAGE_ID "text"                # Edit a message you sent
agend-agent download FILE_ID                      # Fetch an attachment (attachment_file_id)
agend-agent send TARGET "message"                 # Message another agent
agend-agent delegate TARGET "task"                # Assign work
agend-agent report TARGET "summary" [CORRELATION_ID]  # Report results (echo the request's correlation_id)
agend-agent ask TARGET "question"                 # Request info
agend-agent broadcast "message"                   # Message all agents
agend-agent delivery-status --operation-id ID      # Check a previously accepted delivery

# Instance Management
agend-agent usage                                 # AI subscription usage (all providers)
agend-agent list                                  # List running agents
agend-agent describe NAME                         # Get agent details
agend-agent start NAME                            # Start stopped agent

# Task Board
agend-agent task create "title"                   # Create task
agend-agent task list                             # List tasks
agend-agent task claim ID                         # Claim task
agend-agent task done ID "result"                 # Complete task

# Decisions
agend-agent decision-post "title" "content"       # Post decision
agend-agent decision-list                         # List decisions
```

If a send result is unclear, query its returned operation ID with
`agend-agent delivery-status --operation-id ID` before deciding what to do.
An `uncertain` result may already have reached the target; do not resend blindly.

## Rules

- `[user:… via telegram|discord|web]` → use `agend-agent reply` (NOT `agend-agent send`)
- `[from:INSTANCE]` → use `agend-agent send` or `agend-agent report` to answer the sending agent; AgEnD appends the runtime-specific rule for any requested channel-facing action.
- Everything for a human user goes inside the `agend-agent reply` command. Your final
  terminal text is NOT delivered to their chat — it only reaches local logs and
  `/view`. After the command succeeds, end the turn with final text of exactly `.`
  (some backends such as Kiro CLI error on a turn with no text at all). Only
  exception: if the command fails, say so in the final text so the failure is visible
  to the operator.
- For cross-instance responses, put the response in `agend-agent send` or
  `agend-agent report`. After the command succeeds, likewise end the turn with exactly
  `.`; if it fails, put the failure in the final text so the operator can diagnose it.
- Task flow: `agend-agent delegate` → silent work → `agend-agent report`. Zero messages in between.
- Never send acknowledgment-only messages. Only send messages with actionable content.
