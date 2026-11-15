# M-3143: legacy rating survey wrapping

`legacy-width-31.txt` through `legacy-width-37.txt` and
`legacy-clipped-skip.txt` are deterministic reconstructions, NOT live survey
captures. They use the exact title and choices extracted offline from the
official agy **1.5.9** Linux x64 binary. Each physical row is hard-wrapped at the
named width and its trailing blanks trimmed, as in capture-pane output. The
clipped fixture ends at `[0] Sk`; tests also cover all shorter/full Skip prefixes.

Offline binary evidence:
- The archive contains only `antigravity`; no separate bundled assets.
- At file offset0x642a64b,49 bytes: `How's the CLI experience so far? Help us improve:`.
- At0x63c7b59,34 bytes: `[%s] %s  [%s] %s  [%s] %s  [%s] %s`.
- The rendering instructions reference that format and eight static string
  arguments: `1`, `Good`, `2`, `Fine`, `3`, `Bad`, `0`, `Skip` (globals
  0xd10cd80 through0xd10cdf0; read through ELF relocations and string lengths).
- No short question or slash-separated four-choice marker occurs in the binary.
  The previous report-based matcher/fixture has been removed entirely.

The two `captured-*.txt` files are real `tmux capture-pane -p` output from an owned
isolated signed-in1.5.9 rig on2026-11-15. Email is replaced with
`[account redacted]` and scratch cwd with `/scratch/agy-work`; other visible
text/spacing is retained. SHA512 matched the official updater manifest. Neither
the installed CLI nor live panes were touched. Sign-in was read-only mounted,
not copied; no credential/authorization URL is in these fixtures.

A bounded20 tiny no-tool replies did not produce the rating survey. Telemetry
and Interactions-data sharing stayed off. `/feedback` is a different qualitative
report form; it was cancelled without submitting. The rig is stopped and its
scratch HOME removed. This is targeted compatibility evidence, not a full audit.

The account received Hydrogen, not the reported Auto-default announcement.
The Auto-default test prefix is labelled synthetic. Existing announcement/Auto
composer behavior is unchanged; there is no automatic Escape.
