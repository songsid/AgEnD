---
section: Fixed
---
- Keep the last five valid `fleet.yaml` and `classicBot.yaml` sources in a private SQLite history. Invalid YAML now raises one Needs-you item while the running settings stay in force; a subsequent start can use that file’s stored valid source without overwriting the broken file. Broken YAML without usable history fails clearly; schema errors keep their existing policy.
