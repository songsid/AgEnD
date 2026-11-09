# Offline Kiro2.36 →3.0 TUI/V2 exact-resume proof

Run `run.py` twice, each time in a **separate disposable network-none container** (uid1000,2GiB RAM/swap,1CPU,
512PIDs, no systemd/binfmt/privileged mode), from the built source checkout. Mount only this checkout/dependencies
read-only, the selected downloaded Kiro bin directory read-only, and a new owned output directory writable at
`/proof`. Never mount a real HOME, provider profile or installed CLI. The script checks uid and the lack of routes.

- Phase2: set `KIRO_BINARY=/kiro/kiro-cli`, `PROOF_PHASE=2`, `PROOF_ROOT=/proof`,
  `PROOF_SOURCE_HEAD=<exact commit>`, mount the full **2.36.0 bin directory** at `/kiro` (including its chat helper).
  Run `python3 scripts/manual/kiro3-tui-resume/run.py`. This bootstraps a scratch auth DB and seeds only never-valid
  dummy data; it installs the documented synthetic saved-session fixture and a newer sibling in that scratch home.
- Wait for that container to exit completely. Phase3 uses a new container, same output mount and env except
  `PROOF_PHASE=3`, with the unmodified **3.0.0** bin directory mounted at `/kiro`. Run the same command.

The script refuses a reused phase2 profile or a missing/foreign-head phase2 receipt. Both phases use a private
PID-named tmux socket and the existing AgEnD TUI flags plus model and exact `--resume-id`. A recognized empty
composer gets only `/session-id`, whose draft is observed before Enter; no retirement choice is answered. It
requires the old canary and exact UUID, excludes the newer sibling, and hashes the unchanged transcript. No model
turn, mock ACP, TUI patch or vendor account is used. The private server closes in finally; the disposable PID
namespace contains all children. Retain receipts/captures and remove only the owned synthetic profile afterward.

Run the fixture/backend regressions separately with:

```sh
npx vitest run tests/kiro3-tui-resume.test.ts tests/kiro3-readiness.test.ts tests/kiro3-needs-you.test.ts
```

See the fixture README for provenance and limits. In particular, this is an offline exact-resume control, not
permission to migrate a real account, automatically update Kiro, select V3, or raise the general steering/version
support ceiling.
