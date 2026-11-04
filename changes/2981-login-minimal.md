---
section: Changed
---
- **`/login`: one link per sign-in, and the right words (#2981).**
  - A Claude Code or kiro sign-in no longer posts the provider's sign-in URL (claude.ai, AWS) and code to the chat as well. The AgEnD terminal you open already shows them, so the chat has its terminal link and the access token stays private, as before. Codex and Grok, which sign in with a device code and have no terminal link, still post their link and code.
  - `/login muse` now says to sign in with muse's own command on the host, not OpenCode's API-key sentence.
  - A bare `/login` lists Antigravity as one short line ("sign in on the host: run `agy` there"), not the whole explanation that `/login agy` gives.
