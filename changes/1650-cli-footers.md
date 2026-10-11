---
section: Fixed
---
- **Agents in CLI mode are told the commands they actually have (#1650).** An instance with `agent_mode: cli` has no MCP tools, but every message it received still ended with "Reply using the reply tool" or "use send_to_instance / report_result". Those footers now name the `agend-agent` commands: `agend-agent reply "…"` for a user, and `agend-agent report <sender> "…" <correlation_id>` or `agend-agent send <sender> "…"` for another instance. Instances in the default MCP mode see exactly what they saw before.
