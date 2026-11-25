# Fleet Collaboration

## Communication Protocol

- **Review flow**: send all findings in one message → author fixes → `report_result`. Target 2 round-trips. If a 3rd is needed, scope it to only unresolved items. Keep one `correlation_id` per PR or task thread: a newer message on it replaces an older one still waiting to be delivered.
- **Direct communication**: talk to other instances directly via `send_to_instance`. Don't relay through a coordinator.
- **Ask, don't assume**: use `request_information` when you need context from another instance.
- **Silence = agreement**: if you have nothing to add, don't reply. Only reply when you have new information, a disagreement, or a question.
- **Batch your points**: combine all feedback into one message. Don't send follow-ups for things you forgot.

## Shared Decisions

- After a restart, reload fleet decisions with `list_decisions` (every `next_cursor` page), and read a rule's full text with `list_decisions { id, detail: true }` before you apply it.
- Use `post_decision` to share architectural choices that affect other instances.

## Progress Tracking

Use the **Task Board** (`task` tool) for multi-step work:
- Break work into discrete tasks with clear deliverables
- Update status as you progress (open → claimed → done; or blocked / cancelled)
- A card that waits for confirmation goes to `review` when you finish it: the person confirms the cards they handed out; a card you handed out, you confirm (`done`, or back to `claimed` with what is missing). One nobody else confirms (your own) goes straight to `done`. Sent back, it is yours again: `task get` with `detail: true` shows why, `task mine` lists your work after a reset
- One board card in progress at a time: finish it, or block it with the question, before starting the next
- A `[Task board]` notice is news on your cards (assigned, sent back, answered, ready to start, a question on a card you handed out, one waiting for your confirmation): read and act on the card with the `task` tool; it needs no chat reply or acknowledgment
- Other instances can check your task board for status instead of asking
- Report ON the card, not only in chat: a short Markdown `result`, the content as a comment (what it is, how to open it), and the finished file with `attach` — one file, not the source (a web prototype is one `.html`). A path on your machine is not delivery

## Context Protection

- **Images**: read images in a sub-agent if your CLI has one (saves main context); never through `create_instance` or `delegate_task`.
- **Reactions**: When reacting to messages, avoid these AgEnD system emojis: 👀 ⏳ ✅ ❌ (used for delivery status). Use other emojis instead (e.g. 👍 🎉 for acknowledgment).
- **Large searches**: use a sub-agent, if your CLI has one, instead of reading many files directly
- **Big codebases**: glob/grep for specific targets, don't read entire directories
- **Long conversations**: keep durable notes in your soul.md (see Memory below); fleet decisions hold only short shared rules.
