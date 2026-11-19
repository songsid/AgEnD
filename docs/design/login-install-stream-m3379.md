# Install-output fixture completion

The failing CI test accepted `pane_dead == 1` as proof that the terminal grid
contained the install wrapper's final output. On the recorded run, that condition
and the error prefix were present, but the wrapper's exit marker was missing
(base `tests/login-install-stream-2980.test.ts:120–128`). Retrying passed.

Pane death is not an output-completion acknowledgement. In tmux 3.4,
[destruction readiness](https://github.com/tmux/tmux/blob/3.4/window.c#L368)
checks pending pipe output and unread PTY bytes only with an output pipe attached;
[destruction](https://github.com/tmux/tmux/blob/3.4/server-fn.c#L306) can close the
PTY before retaining its existing grid. That supports a trailing-output race; the
exact reaper/read ordering of the CI failure was not recorded.

The fixture attaches an output observer before enabling remain-on-exit. The
observer sees the complete run-specific verdict and signals its private
`wait-for` channel. The controller awaits that acknowledgement, then captures once.
The pipe also keeps tmux's drain checks active. The original deliberate 500 ms
gate delay, five-second observation budget and 15-second test timeout remain.
There is no retry or output-capture poll. Production install code is unchanged;
this protected fixture does not prove retention for production's no-pipe path.

Every fixture client uses an owned filesystem socket and ignores user tmux
configuration. Outside the private pane, subprocesses receive no inherited TMUX,
TMUX_PANE or AGEND_TMUX. Inside it, tmux supplies its private context. TmuxManager
and its live default socket are never used. Cleanup targets only that owned socket.

The deterministic reproducer injects the observed late-publication ordering at
the capture boundary. It withholds the captured verdict until output completion
has actually been observed. It fails the unchanged base at the same assertion and
passes the signal-based fixture. This is a controlled frame-order model, not a
claim of reproducing a particular native event-loop schedule. Uninjected runs
exercise the real wrapper, PTY, observer and tmux server.

The same test exists on main, so a separate main twin is required. The two branches
have different wrapper binary-selection lines, but the fixture clears AGEND_TMUX
and selects the same private binary through PATH. No production behavior, user
skill, permission, package or timeout changes are included. Rollback is a test-only
revert.
