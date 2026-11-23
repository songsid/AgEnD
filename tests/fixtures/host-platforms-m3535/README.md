# Platform fixtures

Memory tests reuse the existing recorded/sanitized `darwin-memory` vm_stat, swap and kernel-pressure files and the reported WSL2 PSI recording in `linux-memory-pressure`. The latter is Linux kernel-format data tested through both Linux and WSL adapters; this is not a claim of a new native Ubuntu run. RAM/swap counter combinations and malformed variants are controlled test inputs. Existing fixture SOURCE/README files retain their provenance.

`disk-legacy-recording.json` was produced by executing the exact pre-extraction provider from base ffe38322808e28822079c02a3473cbf507ae3c62 and the new provider against identical injected command responses, clocks and mount inventories. All three platform disk outputs and exact command sequences matched. Device/path names, capacities and APFS container are synthetic. No disk command or native OS collection ran. Its expected IDs and shared-pool bindings pin compatibility independently of the final source.
