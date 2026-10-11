# kiro-cli 2.29.0 → 2.29.1 audit fixtures (#1636)

Static evidence only; no kiro binary was run. Each `kiro-cli-chat-<version>.strings.txt` lists, for the literals the
rate-limit and monthly-limit patterns are built on, how many times they occur in that version's `kiro-cli-chat` and the
bytes around the first one (control bytes shown as ␠-style placeholders). Both versions carry every literal exactly once,
so 2.29.1 changed nothing on this surface; the precheck's MAJOR (`precheck-2.29.0-2.29.1.txt`) came from the string
pool's order: in 2.29.0 `Kiro rate limit reached:` sat directly before `Please try a shorter message.` and was read as
one token.

`upstream-chat-mod-throttling-monthly.rs.txt` is the upstream Amazon Q Developer CLI code for the two branches: the
Throttling branch prints the rate-limit line and `Request quota exceeded…` and sets `display_err_message = false`, so the
`… having trouble responding right now:` header is not printed; MonthlyLimitReached prints `Monthly request limit
reached` with the reset date and returns. That is why neither output matched any kiro error pattern before #1636.
