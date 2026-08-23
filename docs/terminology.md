# AgEnD Terminology Guide

This guide keeps user-facing text, documentation, and configuration references consistent across English and Traditional Chinese (`zh-TW`).

## Preferred terms

| Concept | Formal English | zh-TW user-facing | zh-TW technical/config prose | Meaning |
|---|---|---|---|---|
| Instance | Instance | Agent | instance | One AgEnD-managed CLI process. Use “Agent” when explaining what the user interacts with; use `instance` for identities, settings, and configuration. |
| Backend | Backend | Backend | Backend | The CLI or AI service that drives an Agent, such as Claude Code, Codex, or Kiro CLI. |
| Context | Context | Context | Context | The amount and content of the current conversation that the model can retain. |
| Fleet | Fleet | Fleet | Fleet | The collection of instances managed together by AgEnD. |
| Working directory | working directory | 工作目錄 | 工作目錄 | The project directory in which an instance runs. |
| General | General | General | General | The coordinator instance for a Fleet. Treat it as a product role and retain the capitalized name. |
| Working | working | 工作中 | 工作中 | The instance is actively processing work. |
| Idle | idle | 閒置 | 閒置 | The instance is ready and not actively processing work. |

## Writing guidance

- In English, use the formal terms in the table. Capitalize product labels and glossary definitions; lowercase ordinary technical prose and literal names where English grammar or a configuration/API name requires it.
- In zh-TW user-facing text, call the thing a user talks to an “Agent”: for example, “你的 Agent 正在工作中”. Use `instance` when referring to an instance name, instance setting, API field, or configuration object.
- Keep `Backend`, `Context`, `Fleet`, and `General` in English in zh-TW text. On first use for beginners, add a short plain-language definition instead of translating the term.
- Keep literal filenames, commands, and configuration keys unchanged, such as `fleet.yaml`, `working_directory`, `backend`, and `context_guardian`.
- Do not alternate between translated and untranslated forms. Avoid using「AI 助手」for Agent,「後端」or「AI 引擎」for Backend, and「上下文」「前後文」「對話空間」for model Context.

## Important distinctions

- A **bot is not an Agent**. A bot is the Telegram or Discord account that carries messages; an Agent is the AgEnD-managed CLI process that handles them.
- **ClassicBot** is a product term. Do not shorten it to “Classic” or use it as a synonym for bot, Agent, or instance.
- Claude Code and OpenCode may use the terms **agent** or **subagent** for their native internal workers. Those are not AgEnD instances. When ambiguity is possible, write “Claude Code subagent”, “OpenCode agent”, or “AgEnD instance”.
- **Working is not running**. A running instance may be either 工作中 or 閒置. “Running” describes process availability; “working” describes current activity.
- A **session** or exported conversation record is not Context. A session is persisted conversation history; Context is what the model can currently retain and use.
- Generic uses of the English word “context” do not always mean model Context. Use capitalized `Context` only for the AgEnD/model concept; translate ordinary meanings according to the sentence.
