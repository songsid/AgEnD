---
section: Changed
---
- **CI no longer adds to `@songsid/agend`'s npm download count (#1819).** The jobs that install the published 2.1.12
  (the Node 20 rollback smoke, the data-downgrade check, the runtime-acceptance hop and the Mac GUI rehearsal) fetch
  its tarball once, keep it in the Actions cache and check it against the registry's `dist.integrity` before every
  install; a mismatch fails the job. The install fails if npm fetched our tarball anyway.
