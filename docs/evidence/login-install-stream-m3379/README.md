# Install-stream fixture completion

The CI failure was a missing final verdict, after the pane-dead check and the
error-prefix assertion had passed (`tests/login-install-stream-2980.test.ts:128`
on the base). The fixture treated pane death as an output-publication barrier.
The exact native callback ordering was not captured; the upstream drain/close
paths and the bounded fix are described in the [design](../../design/login-install-stream-m3379.md).

The replacement uses a private filesystem socket and an output observer installed
before the wrapper is released. It waits for the complete, run-specific verdict,
then captures once. All subprocesses outside that pane discard inherited tmux
selectors. The original 500 ms gate delay, 5 s observation budget and 15 s test
timeout stay unchanged. There are no retries.

Validation is in [validation.json](validation.json):

- The committed manual reproducer fails the exact unchanged base at the original
  verdict assertion (one failed, 26 unselected), and passes the fixed native case
  (one passed, 28 unselected). This deliberately injects late publication at the
  capture boundary; it does not pretend to force a vendor event-loop schedule.
- Twenty consecutive, uninjected full-file runs on a privately built upstream
  tmux 3.4 pass: 29 tests per run, no failures or skips, `--maxWorkers=2`.
  That is 580 executions of 29 distinct cases, without retries.
- Removing environment isolation or capturing before completion each makes its
  respective focused control fail. The file is restored afterward.
- The test TypeScript check exits zero with no diagnostics.

To repeat the forced ordering, provide two prepared checkouts (dependencies
installed and tmux on PATH), then run the fixed checkout's driver once against
each. It sanitizes the child environment and refuses unscoped tmux calls:

```sh
node scripts/manual/repro-login-install-stream-m3379.mjs /path/to/base-checkout
node scripts/manual/repro-login-install-stream-m3379.mjs /path/to/fixed-checkout
```

Expected exits are 1 and 0, respectively. The script also refuses a skipped or
unselected native case. No TmuxManager is instantiated, and cleanup addresses only
the fixture's own socket. Private binaries and raw logs are not part of this PR.

The production install path is unchanged. Attaching a pipe also keeps tmux's drain
checks active, so this fixture does not establish retention on production's
no-pipe path. Main has the identical original test, requiring a separate twin;
its one wrapper binary-selection difference is recorded explicitly in the JSON.
There is no user-visible change or changelog fragment. Rollback is a test-only
revert. No browser, backend model or live account campaign was run.

## Main twin

This branch cleanly cherry-picks the reviewed dev fixture onto current main. The
original test blob and all four submitted source/design files match exactly.
[main-port.json](main-port.json) binds that comparison and states the wrapper's
binary-selection difference. The 20 native runs and fault-injection results above
were obtained on the dev source, which is carried unchanged; they are not new
main-branch executions. No extra native campaign is claimed. Exact-head main CI
is required. The revised order is main first, then dev #4230.
