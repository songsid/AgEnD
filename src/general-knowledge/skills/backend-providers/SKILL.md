---
name: backend-providers
description: Configure custom model providers when creating or editing AgEnD Codex or OpenCode instances. Use for local, OpenAI-compatible, GLM, or other non-default provider endpoints and for backend_options provider selection.
roles: [general]
---

# Backend Providers

AgEnD selects a provider; the backend CLI owns endpoint and credential definitions.

## Choose the backend

| Backend | Provider configuration |
|---|---|
| Codex | Select with `backend_options.codex.provider`; define the provider in Codex `config.toml`. |
| OpenCode | Define the provider in `opencode.json`; use model ID `<provider>/<model>`. |
| Claude Code, Kiro CLI, Antigravity, Grok | Provider is fixed by the CLI; do not set `backend_options` for provider selection. |

## Create a Codex custom-provider instance

1. Define the provider in the fleet user's `~/.codex/config.toml`. The table name is the provider ID used by AgEnD:

```toml
[model_providers.glm]
name = "GLM"
base_url = "https://provider.example.com/v1"
env_key = "GLM_API_KEY"
```

Keep credentials out of `config.toml`. `env_key` names an environment variable; it is not the secret itself.

2. Put the credential in the fleet process environment before startup. `~/.agend/.env` is the usual location:

```dotenv
GLM_API_KEY=replace-with-the-real-secret
```

Restart the fleet after changing its environment. Exporting a variable in an unrelated shell after the fleet has started does not update the running fleet process.

3. Create the instance with the MCP tool:

```json
{
  "directory": "/home/user/projects/my-project",
  "topic_name": "glm-worker",
  "backend": "codex",
  "model": "GLM-5.2",
  "backend_options": {
    "codex": {
      "provider": "glm"
    }
  }
}
```

The equivalent per-instance fleet.yaml override is:

```yaml
instances:
  glm-worker:
    working_directory: /home/user/projects/my-project
    backend: codex
    model: GLM-5.2
    backend_options:
      codex:
        provider: glm
```

AgEnD copies the user's Codex settings into the instance-isolated `CODEX_HOME`, then launches Codex with `model_provider="glm"`. Provider IDs may contain only letters, digits, `_`, and `-`.

## Configure OpenCode

Define the endpoint, SDK adapter, credentials, and models in OpenCode's `opencode.json` provider block:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "glm": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "GLM",
      "options": {
        "baseURL": "https://provider.example.com/v1",
        "apiKey": "{env:GLM_API_KEY}"
      },
      "models": {
        "GLM-5.2": {
          "name": "GLM-5.2"
        }
      }
    }
  }
}
```

Then use the fully qualified model ID in AgEnD:

```yaml
instances:
  glm-opencode:
    working_directory: /home/user/projects/my-project
    backend: opencode
    model: glm/GLM-5.2
```

OpenCode provider IDs and model IDs come from its own config. Do not use `backend_options.codex.provider` for OpenCode.

## Verify and troubleshoot

- Run `validate_config` before reload or restart.
- Use `describe_instance` to verify the effective backend and model after creation.
- If Codex says the provider is unknown, verify the `[model_providers.<id>]` table is in `~/.codex/config.toml` before the instance starts.
- If authentication fails, verify the variable named by `env_key` exists in the fleet process environment; never paste the secret into fleet.yaml or `backend_options`.
- A model-metadata fallback warning can be normal for a custom model with no built-in metadata. Provider connection, authentication, or unsupported-model errors are not normal and should still be investigated.
