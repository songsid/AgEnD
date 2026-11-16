# Personal-agent PM revision

This addresses Lumen's 13 copy/layout points on #4061. It changes no production registration or Windows support
claim. Both PRs remain drafts with the x64 proof, activation and rollback holds. No Windows host, real sign-in,
provider, model or installer execution was used.

| Point | Change |
| --- | --- |
| 1 | A primary sharing button and persistent Not shared yet message. A display-only `agent.shared` reflects a current, time-valid ask grant or membership in a non-archived room with a person. It grants no authority. |
| 2–4 | Replacement is quiet at the bottom. Disconnect is a danger action, confirms that nothing is deleted/uninstalled, and uses 連接. Cancel leaves the binding intact. |
| 5–6 | The agent keeps Ready/Working; the CLI says Can be used. Unavailable Codex is explained separately and excluded from the selector. |
| 7 | A closed shared disclosure gives certificate, Node and expiry help. The fingerprint proves Runtime identity; it does not install OS certificate trust. Personal terminal advice matches the help and offers no trust bypass. |
| 8–10 | One named local Hub agent folder, consistent 你, Default model, and Windows only for now. No Windows 11 claim. |
| 11 | Copy is primary while a private command is shown; New command is quiet. Expired commands are replaced by the agreed text and the new-command control. |
| 12–13 | Existing `.form` spacing and action rows; named administrator allowlist has the administrator-only empty state. |

## Checks and scope

- `vitest run tests/hub-personal-ui-m3224.test.ts tests/hub-personal-owner-m3224.test.ts --maxWorkers=2`:
  26/26 (16 UI, 10 owner). New cases cover sharing state/expiry, available options, setup expiry, confirmation
  and cancelling without disconnect. Initial fixture columns, confirm stub and page teardown were corrected.
- `vitest run tests/runtime-install-script.test.ts --maxWorkers=2`: 26/26.
- `vitest run tests/runtime-install-pwsh.test.ts -t 'personal failure advice' --maxWorkers=2`: skipped locally,
  because `pwsh` is absent (66 tests skipped, including the two selected new cases). The new cases must execute
  in CI's PowerShell partition. This is not a local PowerShell or Windows proof.
- Twelve ordinary install/enrollment command outputs are byte-identical to the prior public source. Only the
  explicit personal mode changes failure advice. Ordinary install-only typing is unchanged.
- Both TypeScript programs exit 0 at `1519b2b57990b5fc3a3218a95c376a8aff81e9a6`.
- Four focused semantic reversals caught: grant expiry, eligible CLI options, sharing control and personal
  command advice. Original sources were restored. The original six controls retain their earlier scope.

The requested headless Linux retake at `8665c6be7a96f3862c015036e149cae08f245237` passed 46 checks and wrote
18 original PNGs. The later change only narrows an unused type declaration; runtime markup is identical.
The script uses the real product HTTPS shell, HTTP, SQLite and audit with inert directory/Runtime execution.
No vendor CLI or installer is run. Both language/theme/width combinations include empty/filled admin cards,
install with closed/open help, CLI options, Ready, Working, offline and disconnect confirmation.

Every original was opened for visual inspection: no clipping, horizontal overflow, large blank bands or exposed
token. The CLI-options capture sets the native select's `size=2` only for the screenshot, showing its unchanged
blank/Claude options because Chromium's native popup is outside page capture. Widths stay 1366/390; height expands
only to include the entire card. Enrollment tokens are masked in every capture and restored afterward.

The first retake waited on an explicit `role` attribute, but the product uses a native `<dialog>` with implicit
role. The harness now captures `dialog[open]`; the real dialog and Cancel path pass in both languages.

## Remaining holds and rollback

Lumen's acceptance and exact-head CI are pending on this revision. The production migration stays unregistered.
The actual Windows x64 enforcement/real-answer proof still needs the leader's forwarded authorization, account,
profile and time slot. Functional rollback hides the optional controls/disables admission while retaining a
compatible binary and journals; hard downgrade requires the documented complete pre-registration backup.
