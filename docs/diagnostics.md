# Storage and host resources

## On-demand CPU profiles

The local OS operator can record the fleet's main-thread CPU profile at its next cold start:

```sh
AGEND_CPU_PROFILE_SECONDS=60 agend fleet start
```

The variable is read only by the cold `fleet start` path (including a cold single-instance start), not by HTTP, MCP, Settings, or commands delegated to an already running fleet. It is disabled when omitted. Agent sessions carrying `AGEND_INSTANCE_NAME` are refused. This is an OS-operator boundary, not a sandbox against code already running as that same OS user. For a managed service, its operator can set the environment for one start and remove it afterward; do not leave it enabled for routine restarts.

- Integer duration: 1–1,800 seconds, checked with `performance.now`. It stops at the deadline or on graceful fleet shutdown. A blocked main thread cannot service its timer: stop happens on the first opportunity afterward. Inspector commands have a two-second response budget; saving has a five-second wait budget and an abort signal prevents later storage steps. Already-issued filesystem operations may finish after that wait. Failed probes or writes warn and do not prevent fleet startup.
- Sampling: 100 Hz, using an in-process [Node inspector Session](https://nodejs.org/docs/latest-v22.x/api/inspector.html#cpu-profiler). No inspector listening port is opened. It samples JS callers beyond the slow-call ring, including stacks that invoke blocking native work; it cannot promise a detailed native/GC stack or causal proof for every stall.
- Output: `AGEND_HOME/profiles/fleet-cpu-*.cpuprofile` (normally `~/.agend/profiles/`), 0600 files in an operator-owned real 0700 directory. Symlinks/non-owned artifacts fail closed. Rotation retains five owned artifacts, at most 20 MiB each; unrelated files are untouched. Oversized output is discarded, never truncated into invalid JSON.
- The artifact size cap is **not** a byte cap on V8's native recording memory or the JSON serialization allocation. Sampling and duration limit ordinary growth, but profiling itself consumes memory/CPU and serialization can add a stall. Start with a short capture on a memory-constrained host.

The log prints the saved path. Open the file manually in a compatible CPU-profile viewer (for example Chrome DevTools' Performance panel); compare the stacks and timestamps with the stall warnings. Profiles contain source paths/function names and may expose sensitive script URLs. They are never posted to a channel or served by the web UI automatically. Abrupt process termination can lose the capture.

`agend doctor` and the text output of `agend fleet status` include:

- Each configured workspace, including inherited `working_directory` values and ClassicBot workspaces. Retained directories under `AGEND_HOME/workspaces` also appear. Paths pointing to the same real directory share one measurement and list their instance names.
- Directories under `AGEND_HOME/instances` that are absent from both `fleet.yaml` and `classicBot.yaml`, with their paths and disk usage. This is a report for manual inspection: an unregistered directory is not proof that its data can be deleted.
- Host RAM available/total and swap free/total. Linux prefers `MemAvailable` and reads swap from `/proc/meminfo`. macOS uses bounded asynchronous `/usr/bin/vm_stat` and `/usr/sbin/sysctl vm.swapusage` probes to estimate available RAM and read swap; unreadable or invalid measurements stay unknown rather than using free RAM as availability. Other platforms, and Linux's portable fallback, report explicitly labeled free RAM and unknown swap. Zero swap is distinct from unavailable swap data. These host figures are separate from per-instance or fleet process memory; on macOS they are diagnostic only and do not restrict spawn admission. See [host memory pressure](memory-pressure.md#macos).

For the same report beside the regular instance list, use `agend ls --resources`. Ordinary `agend ls` retains its fast behavior. Existing `--json` output stays a row array and does not run disk scans; `ls --names-only` remains names only, including when combined with `--resources`.

Disk measurement uses asynchronous `du -sk -x` calls, at most two at a time, with a two-second limit per process and a shared five-second scan budget. Sizes are allocated disk space on the directory's filesystem. Descendant symlinks and nested filesystems are not followed. Explicitly configured workspace roots may be symlinks; their real paths are measured. Implicit unregistered symlinks under the managed directories are skipped. Parent/child workspace measurements can overlap, so no combined workspace total is claimed.

Missing paths, permissions, an unavailable `du`, and scan deadlines produce unknown sizes rather than zero or partial totals. Invalid/unreadable registries, or registries that change during collection, leave directory classification unknown. No directories, Git repositories, registry migrations, archives, or cleanup actions are created by this report.
