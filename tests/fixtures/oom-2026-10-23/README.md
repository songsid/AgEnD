These are real journalctl kernel records supplied by the leader for 2026-10-23. Only the host name was replaced with `fixture-host`. The global report repeats Mem-Info blocks; retain these as a parser regression.

- `global-oom-0112.txt`: unconstrained global OOM, apache2 victim, anonymous RSS 28,607,512 KiB. No AgEnD CLI was the victim.
- `memcg-oom-0156.txt`: tsc killed inside a capped user-unit cgroup. No AgEnD CLI was the victim and this does not prove per-instance ownership.

The test reconstructs a **hypothetical collateral CLI victim** by selecting a small existing node row and replacing only the summary/victim line. The real apache2 hog stays in the task table. Synthetic positive proof is generated in `tests/helpers/self-oom-evidence.ts`, with a complete task table and no allocation.

Additional synthetic cases derive both the Linux 6.6 task layout and the 6.8+ RSS-column layout from upstream `mm/oom_kill.c`; they include spaced task names and the 4096-row boundary. The collector test wraps the real messages in realistic full journal metadata and invokes a private fake `journalctl` through the production execFile wrapper. It never reads the host journal.
