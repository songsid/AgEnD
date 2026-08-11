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

- Run `list_decisions` after restart to reload fleet-wide decisions.
- Use `post_decision` to share architectural choices that affect other instances.

## Progress Tracking

Use the **Task Board** (`task` tool) for multi-step work:
- Break work into discrete tasks with clear deliverables
- Update status as you progress (pending → in_progress → done)
- Other instances can check your task board for status instead of asking

## Context Protection

- **Images**: Use your CLI's built-in subagent/task feature to read images (saves main context). Do NOT use `create_instance` or `delegate_task` for this.
- **Reactions**: When reacting to messages, avoid these AgEnD system emojis: 👀 ⏳ ✅ ❌ (used for delivery status). Use other emojis instead (e.g. 👍 🎉 for acknowledgment).
- **Large searches**: use subagents (Agent tool) instead of reading many files directly
- **Big codebases**: glob/grep for specific targets, don't read entire directories
- **Long conversations**: summarize decisions into Shared Decisions before context fills up
