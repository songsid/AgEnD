---
section: Changed
---
- **Deleting an agent now deletes its chat topic too, and says whether that worked.** `delete_instance` (and Delete on the dashboard and in Settings → Agents) removes the agent's own Telegram topic or Discord channel by default. Pass `delete_topic: false` to keep it.
  - **Through the right bot.** The deletion now goes through the agent's own bot. Before, it went through the fleet's first bot, which on a fleet with both Telegram and Discord could be the wrong platform.
  - **A truthful answer.** `topic_deleted` is true only when Telegram or Discord confirmed it. Otherwise `topic_reason` says why, for example "the Telegram bot lacks the Manage Topics admin right" or "topic not found". The agent is deleted either way.
  - **Never deleted:** the General topic, a topic another agent also uses, and ClassicBot rooms. On Discord the topic is a channel, so its message history goes with it. (#3054)
