---
section: Fixed
---
- **Fleet startup no longer stalls on a large classic kiro store (#2738).** The 2.3.2-beta.13 update could roll back: while launching a classic kiro instance with a long history, the fleet missed systemd's 60-second watchdog and was killed.
  - **Cause:** checking whether the instance's conversation had been compacted (#2714) read every transcript in kiro's store, many times over, on the fleet's main thread. On one host that took about 5 minutes.
  - **Fix:** the check now reads each transcript once, on a background worker, and the fleet stays responsive while it runs. The `migrate_kiro_instance` tool checks the same way.
  - **Time limit:** the check is limited to 30 seconds and 2 GiB per working directory. If it can't finish within those limits, the instance resumes the conversation on record and the Log tab says why, the same as when the compaction is ambiguous.
