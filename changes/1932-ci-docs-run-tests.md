---
section: Fixed
---
- **CI: a PR that changes docs now runs the tests.** Tests read `docs/` files and the root READMEs, so a docs-only PR that changed a row a test pins could merge with the test shards skipped (#1929 turned main red this way). Only a PR that changes nothing but `changes/` fragments skips the tests now. (#1932)
