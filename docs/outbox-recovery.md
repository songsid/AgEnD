# Delivery outbox recovery

[繁體中文](outbox-recovery.zh-TW.md)

`delivery-outbox.db` in the AgEnD data directory contains pending messages,
attempts and submission evidence. If opening or boot recovery fails, AgEnD logs
an error with the path, failure category and recovery instructions. `startAll`
refuses before loading the fleet configuration or starting instances; a failed
store is not published for delivery admission.

| Category | Recovery |
|---|---|
| `busy` | Check for another AgEnD process or database tool holding a transaction. Let it finish, then retry startup. |
| `abi` | Reinstall AgEnD with its supported runtime (`agend update --force`), then retry. Deleting the database cannot fix a native driver mismatch. |
| `corrupt` | Stop AgEnD, back up the database together with any `-wal` and `-shm` files, then restore a trusted backup or repair a copy before explicitly replacing it. |
| `other` | Inspect the original error in `daemon.log`; check permissions, disk space and storage I/O. |

AgEnD does not quarantine or replace the queue on an open failure. Unlike
optional `events.db` history, this store cannot be reset automatically without
losing delivery evidence. Normal SQLite opening and schema migration can still
write to a healthy database, and SQLite itself manages its journal files during an open attempt. Initialization failures close their acquired
connection; recovery failures also close the unpublished store.

Restoring an older backup can lose pending messages or evidence of a submission.
Keep the original files for inspection and reconcile uncertain deliveries before
retrying them. This change adds diagnostics; it does not repair corrupt SQLite
files or promise that restoring a backup prevents duplicate submissions.
