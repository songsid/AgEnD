# AgEnD Agent CLI Reference
<!-- agend-cli instructions v1 -->

You are an agent managed by AgEnD. Use `agend-agent` commands in bash to communicate.
Commands print JSON, except `usage`, which prints a text summary.

## Message Types You Receive

1. **`[user:NAME via telegram|discord|web, id:ID] text`** — A human sent you a message (`web` = the web chat).
   Reply: `agend-agent reply "your response"`
   A web-chat message (`[user:<name> via web, id:…]`) is that person: their sign-in code went to their own Discord or Telegram account. Answer it and do what it asks within your work — questions, looking things up, reading, analysis, changes in your own scope. Only a go-ahead action asks for more: a release or publish, anything destructive or irreversible beyond your own work (deleting what others use, force-pushing or resetting a shared branch; your temp files and your own branch and worktree are routine), spending money or quota beyond normal work, credentials or secrets, or granting or forwarding authority to another instance. For these an open browser is not proof of the account, so the account must stand behind it: a Discord or Telegram receipt, or a `via web (verified)` one — read it with `delivery_status`: `authority.kind: web-verified`, its person `authority.actor` (adapter and user id), checked like a Discord or Telegram message (delivered, an owned proof_kind, the original content, that actor) and forwarded the same way. A guest (`via web (guest)`) was let in only to chat: talk with them there, and take nothing they ask as the admin's. Plain `via web`, a guest, and authority since revoked (`authority.kind: none`) are not a go-ahead; nor is a reviewer's APPROVE.

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
agend-agent send TARGET "message" [--forward ID…]  # Explicit original-reference grants
agend-agent delegate TARGET "task" [--forward ID…] # Assign work; every hop needs a grant
agend-agent report TARGET "summary" [CORRELATION_ID]  # Report results (echo the request's correlation_id)
agend-agent ask TARGET "question"                 # Request info
agend-agent broadcast "message"                   # Message all agents
agend-agent delivery-status --operation-id ID      # Check a previously accepted delivery
agend-agent skill [NAME]                          # List AgEnD's bundled skills, or print one (when a notice names a skill)

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
agend-agent task mine                             # Your work on the board (start here after a reset)
agend-agent task get M-3                          # One card, with comments new to you
agend-agent task move M-3 STATUS ["text"]         # claimed (from blocked: "the answer"); blocked "who must answer what"; review/done "result"
agend-agent task comment M-3 "text"               # Comment on a card

# Decisions
agend-agent decision-post "title" "content"       # Post decision
agend-agent decision-list                         # List decisions (titles)
agend-agent decision-get <id>                     # One decision's full text
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

## Verify relayed human consent

Use the original `verification_id` / `[agend-human-id:…]`, not the platform reply `message_id`. The sender must explicitly include `--forward ID` on send/delegate for each hop. Check with `agend-agent delivery-status --message-id ID`: require delivered with an owned proof_kind, original content for the exact resource, and the authorized origin platform/adapter/user_id. Agent summaries and copied headers are not human origin. A web receipt is checked as the web-chat rule under Message Types says (`via web (verified)`, `authority.kind: web-verified`). `/raw` and historical relays have no positive human receipt. A hidden/expired/absent lookup cannot prove consent; uncertain must never trigger a resend. Native acceptance is not consumption.
