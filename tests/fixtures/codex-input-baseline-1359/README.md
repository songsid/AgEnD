# Codex unknown-baseline evidence (#1359)

Native codex-cli **0.160.0**, production `CodexBackend.writeConfig` / `buildCommand`, a custom localhost Responses
provider (no tools, no account), private `CODEX_HOME` / `HOME` / `AGEND_HOME`, and a private `tmux -S` server.
The whole capture ran inside `unshare -rn` with only loopback enabled. Child environments were allowlisted; no bot
credentials, live fleet, default tmux, account home or vendor network was used. Coredumps were disabled.
Only the scratch working-directory path is replaced with `/home/user/sandbox`; pane content is otherwise unchanged.

## Native race, driven through the actual submitSystemPaste helper

1. In a 120×36 pane, type fourteen lines beginning `OLD DRAFT 1359 shared opening` (below the native collapsed-paste
   threshold). `old-multiline-unreadable.txt` is a real nonempty composer rejected by the parser's eight-row tail limit.
2. F2 opens the native startup warning viewer: `warning-baseline.txt`. This is the helper's unreadable baseline.
3. The helper pastes `OLD DRAFT 1359 shared opening NEW DELIVERY 1359 NOT THE OLD DRAFT` using real bracketed tmux
   paste-buffer, then sends its first real Enter. Both are ignored by the warning viewer (`first-enter-ignored.txt`).
4. Schedule the normal user actions Escape and resize to 120×10 after this Enter but before confirmation. The unchanged
   older draft is now readable (`older-input-readable.txt`). These UI recovery actions are part of the controlled race;
   this is not a claim that an untouched warning viewer closes itself.
5. On pinned main 98a0c80f, the actual helper treats that older draft as its own strand, sends a second Enter and returns
   true. The mock's actual user-turn request contains the old fourteen-line draft and **does not** contain `NEW DELIVERY
   1359`. `wrong-recovery-submitted.txt` is the final viewport (its old echo has scrolled out).
6. With the fix, the same native sequence returns false, sends only one Enter, makes no Responses request and leaves
   the old draft untouched. The fixture tests replay these native frames with inert tmux; ordinary tests never run Codex.

`evidence.json` records the raw result hashes, fixture hashes, verdicts and the actual old user-turn text. The two
baseline Responses requests are the user turn and Codex's automatic thread-title request, not two delivered user turns.
Neither contains the new delivery text; the fixed run makes zero requests.

`submitted.txt` is a separate native positive control: a multiline old draft plus the new paste submitted normally and
has a visible transcript echo above the empty composer. The ten ordinary scenarios and 400 sampled post-Enter frames
also submitted safely or remained unreadable; they did not reproduce the bug without the explicit viewer-recovery race.

## The old warmup fixture

Normal native empty idle is `› Ask Codex to do anything` plus Context, as the existing v0160/v0162 fixtures show.
A bare `›` with Context is also native when the draft contains only spaces, but is deliberately unreadable to this
parser. It cannot serve as a **readable empty** baseline. The warmup strand test now uses the existing native idle
fixture before paste and preserves every original assertion on the deliberately swallowed Enter after paste.
