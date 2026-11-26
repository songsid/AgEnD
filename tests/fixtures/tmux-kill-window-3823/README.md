# A fresh socket for each tmux fixture case (M-3823)

The beta.25 tag run 45841921429, attempt 1, job 139986502010 failed the second case of `tmux-kill-window-confirmed.test.ts` at its direct `new-session` setup call, before it constructed a TmuxManager. The first case had just called `kill-server` on the same process-wide socket. The error was `server exited unexpectedly`; the other six cases passed. Read that original log with `gh run view 45841921429 --attempt 1 --job 139986502010 --log`: omitting `--attempt 1` returned the successful rerun log in this investigation.

The fixture reused one socket for all seven cases and treated `kill-server` returning as a barrier to starting another server at that address. On Ubuntu 26.04 under contention, the next client can meet the old server's exit instead of a fresh server. Give each case a new private socket. The final cleanup delta also gives it a short case-owned `TMUX_TMPDIR`, removes that directory after the existing kill-server cleanup, and restores the caller environment. A real socket-path assertion pins that isolation. Original behavioral assertions, budgets and retry policy remain unchanged. No production change is needed for this fixture failure.

## Retained evidence

One disposable `ubuntu:26.04` container, 512 MiB/no swap, one CPU, 128 PIDs, init reaper, ordinary bridge and no published ports. Distro tmux prints 3.6 (package 3.6a-2ubuntu0.2); Node is 22.22.1. No host tmux server was contacted, and no OOM kill occurred.

- Unloaded Python root: 100 reused starts passed.
- Unloaded Node root: 300 reused starts passed.
- Unloaded Node UID 1001: 300 reused starts passed.
- Same Node command sequence under one CPU plus two busy children: reused socket failed on start 133 with the original error, before any product code.
- Change only the per-iteration socket name under the same contention: all 300 starts passed, stopping on any failure. No retry, added wait or longer test timeout was added.

`summary.json` binds the exact executed scripts and records the counts. The retained raw records were also checked separately: all 300 fresh rows have numeric status 0, and the reused run has exactly 132 status-0 rows followed by status 1 and the quoted error. The two Node scripts use the original setup/new-window/kill-window/list-windows/kill-server sequence; `loaded-repro.py` and `loaded-fresh.py` run them with the same two bounded CPU contenders. They are evidence tools, not CI tests. Run them only in a disposable capped container with this folder mounted read-only at `/proof`, distro `tmux`, Node and Python installed, and a writable `/tmp/m3823` owned by the invoking UID. Each wrapper has a 120-second outer campaign bound and terminates its own contenders. Remove the container afterwards; never target a live tmux server.

The fresh-socket control establishes independence from the preceding fixture server. The original runner's scheduling latency and exact system-tmux package were not recorded; do not infer a universal Ubuntu 26.04 product defect. This is container userland coverage, not a VM/kernel or bundled-product-tmux compatibility campaign. Raw command records remain private author artifacts; all passing baselines above remain passing evidence.

The cleanup delta was checked with the focused seven-case suite (7/7) and test typecheck; removing the directory selection causes one real socket-path AssertionError, then byte-exact restoration retains the passing source. the earlier contention evidence still establishes namespace independence and was not repeated.
