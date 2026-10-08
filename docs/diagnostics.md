# Storage and host resources

## Reading an "Event loop stalled" warning

The fleet logs `Event loop stalled for <n>ms` when its single event loop was blocked for a second or more. Slash-command acknowledgements and gateway heartbeats can be missed during one. The warning says what it can about why:

- **`slow sync work`** names the synchronous calls that ran in that window and took long enough to matter. A burst of short calls of the same kind is summed, with its count, for example `tmux.spawn=1200ms (25 calls)`. `unknown` means none of the measured calls did.
- **`in the <g>ms probe gap that held it (<l>ms late, ending <time>) the main thread got <c>ms of CPU: …`** comes from a probe that ticks every 100 ms. A stall shows up as one late gap between two ticks. The CPU time in that gap says what the event loop's thread did during the stall, as far as it proves:
  - **"the thread was running"**: even if the on-time 100 ms of the gap had been busy too, the thread still had CPU for at least 70% of the late part. The stall was synchronous work in this process. Look at `slow sync work`, or take a CPU profile.
  - **"the thread was not running for most of it"**: the CPU was at most 30% of the late part. The thread was waiting, starved by other load on the host (other processes, large test runs on the same machine), or blocked in a system call such as a slow disk.
  - **"not enough to tell running from waiting"**: anything in between.
  - **`the main thread`** is that thread's own CPU (Node's `process.threadCpuUsage`). On a Node version without it, the line says **`the whole process (all threads)`**. That count includes worker threads and can exceed the gap on several cores, so it can only ever show waiting, never running.
  - The line is left out when the window's longest gap is shorter than the stall by more than one probe interval. That gap belongs to some other, smaller stall, so it says nothing about this one. Each 30-second report counts only the gaps that ended in it.
- **`host load a/b/c on N cores`** is the host's load average over 1, 5 and 15 minutes, and its core count, at the time of the warning.

## On-demand CPU profiles

The local OS operator can record the running fleet’s main-thread CPU profile without restarting:

```sh
agend profile          # 60 seconds
agend profile 120      # 1–1,800 seconds
```

The CLI waits for completion and prints the local file path. If no fleet control socket is available, it errors instead of starting a fleet. A recording already in progress (including saving or the startup environment capture) refuses another request and reports remaining seconds. The request uses only `AGEND_HOME/operator/profile.sock`: an owned real root without group/other write permission, a 0700 operator directory and a 0600 owned Unix socket. No TCP listener, inspector port, HTTP entry or MCP tool is added. The directory gates the socket even before socket chmod completes; requests are size-limited with finite input/result waits. Agent environments carrying `AGEND_INSTANCE_NAME` are refused before any filesystem/socket operation. This is a same-OS-user operator boundary, not a sandbox against code already running under that user or able to change its environment.

An explicit fleet admin can use `/profile [seconds]` in **General** (native slash only on Discord; typed command on Telegram). The owner adapter’s nonempty `allowed_users` is required. The immediate acknowledgement returns without holding the channel handler open; completion posts the local path and size in that same General, guarded against replacement bindings and shutdown. The profile file itself is never uploaded.

The startup environment path is also retained:

```sh
AGEND_CPU_PROFILE_SECONDS=60 agend fleet start
```

The variable is read only by the cold `fleet start` path (including a cold single-instance start), not by HTTP, MCP, Settings, or commands delegated to an already running fleet. It is disabled when omitted. Agent sessions carrying `AGEND_INSTANCE_NAME` are refused. This is an OS-operator boundary, not a sandbox against code already running as that same OS user. For a managed service, its operator can set the environment for one start and remove it afterward; do not leave it enabled for routine restarts.

- Integer duration: 1–1,800 seconds, checked with `performance.now`. It stops at the deadline or on graceful fleet shutdown. A blocked main thread cannot service its timer: stop happens on the first opportunity afterward. Inspector commands have a two-second response budget; saving has a five-second wait budget and an abort signal prevents later storage steps. Already-issued filesystem operations may finish after that wait. Failed probes or writes warn and do not prevent fleet startup.
- Sampling: 100 Hz, using an in-process [Node inspector Session](https://nodejs.org/docs/latest-v22.x/api/inspector.html#cpu-profiler). No inspector listening port is opened. It samples JS callers beyond the slow-call ring, including stacks that invoke blocking native work; it cannot promise a detailed native/GC stack or causal proof for every stall.
- Output: `AGEND_HOME/profiles/fleet-cpu-*.cpuprofile` (normally `~/.agend/profiles/`), 0600 files in an operator-owned real 0700 directory. Symlinks/non-owned artifacts fail closed. Rotation retains five owned artifacts, at most 20 MiB each; unrelated files are untouched. Oversized output is discarded, never truncated into invalid JSON.
- The artifact size cap is **not** a byte cap on V8's native recording memory or the JSON serialization allocation. Sampling and duration limit ordinary growth, but profiling itself consumes memory/CPU and serialization can add a stall. Start with a short capture on a memory-constrained host.

The log prints the saved path. Open the file manually in a compatible CPU-profile viewer (for example Chrome DevTools' Performance panel); compare the stacks and timestamps with the stall warnings. Profiles contain source paths/function names and may expose sensitive script URLs. The files are never posted to a channel or served by the web UI automatically; an admin `/profile` request posts only its local path and size in General. Abrupt process termination can lose the capture.

`agend doctor` and the text output of `agend fleet status` include:

- Each configured workspace, including inherited `working_directory` values and ClassicBot workspaces. Retained directories under `AGEND_HOME/workspaces` also appear. Paths pointing to the same real directory share one measurement and list their instance names.
- Directories under `AGEND_HOME/instances` that are absent from both `fleet.yaml` and `classicBot.yaml`, with their paths and disk usage. This is a report for manual inspection: an unregistered directory is not proof that its data can be deleted.
- Host RAM available/total and swap free/total. Linux prefers `MemAvailable` and reads swap from `/proc/meminfo`. macOS uses bounded asynchronous `/usr/bin/vm_stat` and `/usr/sbin/sysctl vm.swapusage` probes to estimate available RAM and read swap; unreadable or invalid measurements stay unknown rather than using free RAM as availability. Other platforms, and Linux's portable fallback, report explicitly labeled free RAM and unknown swap. Zero swap is distinct from unavailable swap data. These host figures are separate from per-instance or fleet process memory; on macOS they are diagnostic only and do not restrict spawn admission. See [host memory pressure](memory-pressure.md#macos).

For the same report beside the regular instance list, use `agend ls --resources`. Ordinary `agend ls` retains its fast behavior. Existing `--json` output stays a row array and does not run disk scans; `ls --names-only` remains names only, including when combined with `--resources`.

Disk measurement uses asynchronous `du -sk -x` calls, at most two at a time, with a two-second limit per process and a shared five-second scan budget. Sizes are allocated disk space on the directory's filesystem. Descendant symlinks and nested filesystems are not followed. Explicitly configured workspace roots may be symlinks; their real paths are measured. Implicit unregistered symlinks under the managed directories are skipped. Parent/child workspace measurements can overlap, so no combined workspace total is claimed.

Missing paths, permissions, an unavailable `du`, and scan deadlines produce unknown sizes rather than zero or partial totals. Invalid/unreadable registries, or registries that change during collection, leave directory classification unknown. No directories, Git repositories, registry migrations, archives, or cleanup actions are created by this report.

## Kiro transcript stalls

Current Kiro stores conversations in a shared SQLite database. Fleet polling
uses a shared worker for readonly queries and history parsing; it does not change
Kiro's schema or indexes. Each source keeps a warm handle and incremental cursor.
A stopped or restarted monitor discards late results. Queue time counts toward
the 15-second read budget; timeouts can temporarily omit progress and do not grant
permission or change delivery results. The worker slot is held until it exits,
preventing repeated timeouts from creating extra workers.

The slow-call ring and CPU profile remain useful for other stalls. The worker
fix does not attribute the earlier periodic warnings with empty sync/GC lists;
see the [snapshot measurements and limits](design/1375-kiro-transcript-db.md).
