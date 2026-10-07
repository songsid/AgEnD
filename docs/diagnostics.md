# Storage and host resources

`agend doctor` and the text output of `agend fleet status` include:

- Each configured workspace, including inherited `working_directory` values and ClassicBot workspaces. Retained directories under `AGEND_HOME/workspaces` also appear. Paths pointing to the same real directory share one measurement and list their instance names.
- Directories under `AGEND_HOME/instances` that are absent from both `fleet.yaml` and `classicBot.yaml`, with their paths and disk usage. This is a report for manual inspection: an unregistered directory is not proof that its data can be deleted.
- Host RAM available/total and swap free/total. Linux prefers `MemAvailable` and reads swap from `/proc/meminfo`. macOS uses bounded asynchronous `/usr/bin/vm_stat` and `/usr/sbin/sysctl vm.swapusage` probes to estimate available RAM and read swap; unreadable or invalid measurements stay unknown rather than using free RAM as availability. Other platforms, and Linux's portable fallback, report explicitly labeled free RAM and unknown swap. Zero swap is distinct from unavailable swap data. These host figures are separate from per-instance or fleet process memory; on macOS they are diagnostic only and do not restrict spawn admission. See [host memory pressure](memory-pressure.md#macos).

For the same report beside the regular instance list, use `agend ls --resources`. Ordinary `agend ls` retains its fast behavior. Existing `--json` output stays a row array and does not run disk scans; `ls --names-only` remains names only, including when combined with `--resources`.

Disk measurement uses asynchronous `du -sk -x` calls, at most two at a time, with a two-second limit per process and a shared five-second scan budget. Sizes are allocated disk space on the directory's filesystem. Descendant symlinks and nested filesystems are not followed. Explicitly configured workspace roots may be symlinks; their real paths are measured. Implicit unregistered symlinks under the managed directories are skipped. Parent/child workspace measurements can overlap, so no combined workspace total is claimed.

Missing paths, permissions, an unavailable `du`, and scan deadlines produce unknown sizes rather than zero or partial totals. Invalid/unreadable registries, or registries that change during collection, leave directory classification unknown. No directories, Git repositories, registry migrations, archives, or cleanup actions are created by this report.
