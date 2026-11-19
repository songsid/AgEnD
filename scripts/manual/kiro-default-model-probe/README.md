# kiro chat.defaultModel warning probe (M-3398, kiro-cli 3.5.0)

kiro-cli 3.5.0 added a startup warning: `warning: chat.defaultModel <id>: is not available, so the session keeps its
default model`. It matched the kiro `model_error` pattern (`/model.*not available/i`), whose handler can restart a
resumed agent onto the fallback model. The pattern now skips a line that says kiro keeps its default model.

`probe.py <rig dir> <version> <model> '<json [[label, [flags…]], …]>'` launches the unpacked tarball's
`kirocli/bin/kiro-cli chat` under AgEnD's flags with `chat.defaultModel` set. Run it inside `unshare -cn` (it refuses a
routed network): scratch HOME and XDG dirs, a never-valid dummy token, a private tmux socket, `coredump_filter=0`, and
SIGINT, never SIGTERM, to stop kiro. It answers only the scratch workspace's trust prompt and the trust-all prompt
(`Yes, I accept`).

Result on 3.5.0 (`--tui --trust-all-tools`, model `bogus-model-x`): kiro reaches its composer showing
`Default · bogus-model-x` and prints no warning. Offline, the TUI's model list fetch fails (`EAI_AGAIN` in its
`kiro.log`), so nothing can call the model unavailable. The warning text is in the Rust binary, not in the TUI bundle
(`tui.js`). Whether it reaches the pane with a live model list was not shown: that needs the real service or a TLS mock
of it. The pattern change is safe either way, since the warning says the session carries on.
