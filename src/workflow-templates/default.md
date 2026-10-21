# Fleet Collaboration

## Communication Protocol

- **Task flow**: `delegate_task` → silent work → `report_result`. Zero messages in between.
- **Review flow**: send all findings in one message → author fixes → `report_result`. Target 2 round-trips. If a 3rd is needed, scope it to only unresolved items.
- **Direct communication**: talk to other instances directly via `send_to_instance`. Don't relay through a coordinator.
- **Ask, don't assume**: use `request_information` when you need context from another instance.
- **Silence = working**: Never send acknowledgment-only messages. If your entire message would be "got it" / "understood" / "working on it" or equivalent in any language — don't send it. Only send messages that contain actionable content.
- **Silence = agreement**: if you have nothing to add, don't reply. Only reply when you have new information, a disagreement, or a question.
- **Batch your points**: combine all feedback into one message. Don't send follow-ups for things you forgot.

## Shared Decisions

- Run `list_decisions` after restart to reload fleet-wide decisions: it lists titles; read the full text only of the ones you need (`list_decisions { id }`).
- Use `post_decision` to share architectural choices that affect other instances.

## Progress Tracking

Use the **Task Board** (`task` tool) for multi-step work:
- Break work into discrete tasks with clear deliverables
- Update status as you progress (open → claimed → done; or blocked / cancelled)
- A card that waits for the person's confirmation goes to `review` when you finish it; only the person confirms it. Sent back, it is yours again: `task get` shows why, `task mine` lists your work after a reset
- One board card in progress at a time: finish it, or block it with the question, before starting the next
- A `[Task board]` notice is news on your cards (assigned, sent back, answered, a comment, ready to start, a question on a card you handed out): read and act on the card with the `task` tool; it needs no chat reply or acknowledgment
- Other instances can check your task board for status instead of asking

## Context Protection

- **Images**: Use your CLI's built-in subagent/task feature to read images (saves main context). Do NOT use `create_instance` or `delegate_task` for this.
- **Reactions**: When reacting to messages, avoid these AgEnD system emojis: 👀 ⏳ ✅ ❌ (used for delivery status). Use other emojis instead (e.g. 👍 🎉 for acknowledgment).
- **Large searches**: use subagents (Agent tool) instead of reading many files directly
- **Big codebases**: glob/grep for specific targets, don't read entire directories
- **Long conversations**: summarize decisions into Shared Decisions before context fills up
