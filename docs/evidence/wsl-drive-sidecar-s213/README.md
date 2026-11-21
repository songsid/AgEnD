# WSL monitoring drive: rollback compatibility (S213)

Selecting a backing drive previously added `monitoring.wsl_drive` to fleet.yaml. The shipped beta.16 reader rejects that unknown key before Fleet startup; turning monitoring off does not prevent the rejection. This release fix stores only the two existing booleans in YAML and keeps the optional drive in a fixed local `host-monitoring-settings.json` sidecar.

## Change and migration

- Atomic replacement through the existing fsync writer, mode 0600, versioned bounded document. Invalid/missing data means automatic detection; symlinks are not followed. The sidecar is separate from history cleanup and is ignored by beta.16.
- Startup and any Fleet config save remove an existing YAML drive through the existing lossless document/alias guard/write path, preserving unrelated comments and extensions. A Settings transaction writes its sidecar first; a rejected YAML write compensates the prior drive and config. Failed sidecar writes cannot update YAML. Cross-file power loss can leave a legacy YAML key for the next startup/save migration; no two-file atomicity is claimed.
- Effective Settings responses project the drive on a copy, not on the persisted FleetConfig. Omitted drive retains the choice, and an explicit empty choice restores automatic detection. Confirmation baselines include sidecar bytes and revision fencing, and classification accepts only the exact validated drive-letter field. Runtime provider replacement reads the sidecar independently of YAML.
- No UI asset, label, geometry, native collection command or sampling cadence changed. No browser, model, account, real Fleet startup or real configuration mutation was run. Scratch FleetManagers exercise the actual Settings handler/config writer only. Existing UI/runtime tests remain in the focused set.

## Proof

`tests/fixtures/host-monitoring-beta16/host-monitoring-config.ts` is an exact copy of `v2.4.0-beta.16:src/host-monitoring-config.ts`, SHA-256 `f732592b9d913c1e4fd5ebcc313a037af442fb966eca6263acff41b0cc37a968`. It is a shipped-reader fixture, not a reconstruction or a full old-runtime rehearsal.

- Before implementation, the three actual Settings/startup/save cases failed at the beta.16 reader with `monitoring: unknown key: wsl_drive` (3/3 semantic failures).
- Final focused run: **170 tests / 11 files pass**. It includes sidecar format/missing/symlink/mode/reset/retention; actual save and reload; startup and ordinary-save migration; YAML/comment preservation; sidecar and YAML write failures; effective response isolation; captured-baseline consistency and a real pending confirmation invalidated by external sidecar drift; runtime provider drain; unchanged mounted Settings UI; alias guard and confirmation/store suites.
- Removing the sidecar from the confirmation baseline makes the new real pending-confirmation case fail: it applies instead of becoming stale. Original source restored; the focused set passed before this controlled mutation, and the affected case was checked again after restoration.
- Canonical `node_modules/.bin/tsc --noEmit` and `--noEmit -p tsconfig.test.json`: exit 0, zero diagnostics. The canonical compiler is the repository's native TypeScript runner; an exploratory alternate compiler was not the acceptance run.

Compressed logs are sanitized (worktree path replaced) and historical outputs are labelled. The manifest binds current proof inputs; no local logs claim CI or the external rollback leg.

## Release and rollback

This is the Leader-authorized dev release-freeze exception; Prism reviews, coordinator alone merges. S213 still requires dev-claude2's external candidate rehearsal: choose drive → beta.16 rollback starts → re-upgrade retains choice. That leg and exact CI/post-merge success are not claimed by the local proof. The prior S207 UI approval is unchanged. S208 remains paused.

After migration, beta.16 ignores the sidecar and starts from compatible YAML; re-upgrading reads the retained preference. Reverting only this fix while continuing to save drives reintroduces the blocker. Do not restore a historical YAML containing the unsupported drive key when rolling back.
