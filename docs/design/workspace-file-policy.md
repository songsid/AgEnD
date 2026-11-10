# Files/Changes and Follow filename exclusions

`src/workspace-file-policy.ts` is the single filename policy for the read-only workspace API and Follow (#3153/#3160). It is fixed, conservative and case-insensitive. It examines every component of a workspace-relative path, so a hidden directory also protects its ordinary-looking descendants. The workspace root itself remains usable.

| Rule | Hidden examples | Boundary |
| --- | --- | --- |
| Prefix | `.envLOCAL`, `.env.example`, `id_custom`, `ID_NEWTYPE.pub`, `kubeconfigPROD` | Any name starting with `.env`, `id_`, `kubeconfig` or `.kubeconfig`; no word separator is required. |
| Contains | `mycredentials.json`, `mysecret.txt`, `appPasswordStore.txt`, `somePrivate_Key.txt` | `credential`, `secret`, `password`, or `privatekey` / `private-key` / `private_key` anywhere in the name. Singular words also cover plurals. |
| Private extension | `server.pem`, `server.KEY.old`, `cert.p12_saved`, `prod.env`, `terraform.tfstate.backup` | `.pem`, `.key`, `.p12`, `.p8`, `.pfx`, `.jks`, `.keystore`, `.kdbx`, `.asc`, `.gpg`, `.ppk`, `.token`, `.env`, `.tfvars`, `.tfstate`, either at the end or followed by a dot, dash or underscore. This also excludes backup copies. |
| Known private name | `.git`, `.ssh`, `.aws`, `.npmrc`, `.npmrc.bak`, `auth.json.saved`, `.claude.json` | The private directory/config names listed in the policy, either exact or followed by a dot, dash or underscore. `.gitignore` and `.github` do not match `.git`. |
| Existing credential/history shapes | `service-account-prod.json`, `.bash_history`, `.zsh_history.bak` | Service-account JSON names and hidden shell/database history names, also with separated backup suffixes. |
| Ambiguous spelling | A backslash or control character in a path | Hidden by the policy; direct workspace paths are independently refused by confinement. |

False positives are intentional: `.environment` and `secretary.md` are hidden. Ordinary `environment.ts`, `identity.ts`, `keyboard.ts`, `tokens.css`, `server.crt`, `.gitignore`, `.github/workflows/ci.yml` and `docs/security.md` remain visible. There is no override that makes a matching file readable through this panel.

This is a filename filter, not a content scanner. An ordinary-looking filename is not proof that its contents are public. Existing realpath, symlink, state-directory, regular-file, size, session/launch and local-admin admission checks still apply independently.

## Consumers

All six `GET /ui/workspace` operations use the same policy:

- **list:** mark hidden entries and refuse opening a matching directory.
- **file / image:** refuse before opening the file, including an ordinary file below a matching ancestor.
- **changes:** retain the hidden filename/status marker but omit its hunks and content-derived line counts. Tracked numstat and patch queries share the same admitted literal path list; untracked additions skip hidden paths.
- **diff:** refuse a direct single-file diff, including deleted paths.
- **follow:** mark the confined structured-event path as hidden, including paths not created yet. Follow returns path metadata only; the existing panel does not open a hidden entry. A direct request still meets the same server refusal.

Hidden filenames remain visible with the existing warning by design; their contents and hunks are not returned. Git status may inspect local repository state, but hidden paths are excluded from the content-derived numstat and patch queries. No new browser module, asset, response field or permission is introduced, so an existing panel continues to consume the same `hidden` flags and refusals.

## Scope and evidence

Cairn's source-only triage on alpha `6babd5debbff80e6cd1c8d4e786eec14e311955e` identified that the old `.env` separator, known `id_` families and word-boundary patterns contradicted the original issue's broader exclusions. Regression tests reproduce all four reported names through the shared functions and the actual owned HTTP listener, with ordinary-file controls and canaries in tracked/untracked files. These fixtures use scratch repositories and synthetic Follow observations, not a real provider CLI or live fleet.

This fix is alpha-only: main has neither `agent-workspace.ts`, `workspace-follow.ts` nor the workspace panel. Windows/paired-PC support and Follow's supported backends are unchanged. Reverting the delta restores the previous filename policy; there is no state or schema migration, and no credential is moved or modified.
