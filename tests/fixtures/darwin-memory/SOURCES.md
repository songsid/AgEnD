# macOS command-output fixtures

Retrieved 2026-10-05. The development host is Linux: these are published captures,
not output from a Mac used for this change. Live macOS validation is pending.
Only metric rows were retained; shell prompts, comment prefixes and indentation
were removed. Counts and page sizes are unchanged. No process/user data is included.

- `vm-stat-4k.txt` and `swap-4k.txt`: [jazlopez CLI capture](https://gist.github.com/jazlopez/be4878e38b6bfafa71f8f4798885fbd3).
  The test's physical RAM total is injected; the unrelated memory_pressure block
  in that capture is not used to infer the total for vm_stat.
- `vm-stat-dts-16k.txt`: [Apple DTS, Kevin Elliott, thread 782023](https://developer.apple.com/forums/thread/782023).
  This is the DTS author's reordered excerpt, not a complete raw snapshot.
  Raw free pages represent 215.078125 MiB; our conservative available estimate
  represents 3121.6875 MiB. The author's prose unit conversion is not used.
- `vm-stat-16k.txt` and `swap-16k.txt`: first metric snapshot in
  [Warp issue 8100](https://github.com/warpdotdev/warp/issues/8100).

Parser contracts were checked against primary Apple source:

- [vm_stat.c](https://github.com/apple-oss-distributions/system_cmds/blob/main/vm_stat/vm_stat.c):
  printed free excludes speculative; the header supplies page size.
- [sysctl.c](https://github.com/apple-oss-distributions/system_cmds/blob/main/sysctl/sysctl.c):
  swap uses two decimal binary MiB and optional `(encrypted)`.
- [vm_resident.c](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/vm/vm_resident.c):
  purgeable counts describe object state and can overlap pageable queue counts.

`free + speculative + max(inactive, purgeable)` is AgEnD's conservative estimate,
not an Apple-defined MemAvailable or the Activity Monitor pressure graph.

## Kernel pressure alarm (#1256)

`kernel-pressure-{1,2,4}.txt` are **synthetic representative sysctl outputs**,
not reporter calibration data or a live Mac run. They follow sysctl's labelled
integer format. The development host remains Linux.

The kernel's [sysctl handler and dispatch conversion](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/kern/kern_memorystatus_notify.c#L1775)
map normal to `NOTE_MEMORYSTATUS_PRESSURE_NORMAL`, warning/urgent to WARN, and
critical to CRITICAL; the sysctl returns those dispatch flags, not its internal
enum. This is the source of the 1/2/4 contract, with other values left unknown.
The read-only sysctl is masked in release builds and is not a stable public API.
