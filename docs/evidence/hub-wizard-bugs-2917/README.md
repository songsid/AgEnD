# Hub CLI setup fixes — #3658 / M-2917

`agend hub init` used to treat an unapproved fetched-leaf fingerprint as cancellation of the whole wizard. The directory endpoint was validated only after the CA/profile/DN questions. Password-method and private-file prompts used echoing readline, so a misplaced password appeared in scrollback. Certificate copy explained browser warnings without the company-join trust/hostname requirements; the handoff still led only with manual pairing and `/web`.

The wizard now loops at the CA choice without granting trust or repeating earlier questions, validates the LDAPS endpoint before the CA step, and hides all input in the password-acquisition step. Raw mode disables echo before the prompt is painted. The existing runtime validator, fingerprint match, pinned CA fetch, immutable admin lookup, final confirmation, sealed initializer and private secret writer are reused.

The leader approved the EN/zh-TW wording, including the shorter certificate warning. The handoff leads with company-account sign-in and keeps pairing codes under Advanced. All wording remains in `src/hub/init/text.ts` for the upcoming Phase A vocabulary replacement. No browser UI, roles, company-join protocol, certificate trust rule or service behavior changes.

## Checks

| Contract | Baseline | Candidate / guard reversal |
| --- | --- | --- |
| Enter or a wrong fetched fingerprint keeps answers, grants nothing | Whole wizard cancels | Back to CA choices; no CA fetch on mismatch; exact-pin positive control |
| Empty, whitespace or non-LDAPS endpoint | Advances into CA questions | Five invalid-endpoint controls re-ask the address before any probe |
| Password mistyped at method choice | Echoes the canary | Hidden invalid input, correction completes; private-file path is hidden too |
| Certificate guidance before generation | Browser warning only | Trusted CA and different Hub/Fleet hostnames explained in both locales |
| Completed handoff | Manual pairing only | `/ui/hub`, company-account one-box address first; Advanced manual flow retained |

- `fail-first.log`: original alpha `9c98307c938b77d8eaaebf5bcd3f20c5c27dce6f` with test-only commit `a37e43bbd` gives **13 assertion failures / 1 exact-pin control pass** across all five defects. Later supplemental CA-confirmation controls and approved-copy edits are not relabelled as that original run.
- `final-focused.log` / `restored-focused.log`: **145/145** across eight suites: new setup regressions, wizard, initializer, private-file wizard, handoff, initialization lookup, directory certificate and private-file CLI composition. The expanded run first exposed an obsolete echoing-answer fixture in the existing private-file CLI test; it now supplies hidden method/path answers while retaining its exact-byte, secret/argv and no-service assertions.
- `source-types.log`, `test-types.log`: both native TypeScript checks pass. Changelog assembly validation and shell/Python/JS syntax checks pass.
- `mutations.json`: **10/10** independent regressions fail assertion tests (not loader/transform failures): whole-wizard cancellation on fingerprint refusal; missing fingerprint match; skipped early URL validation; echoing method/path; cancellation on imported/fetched CA non-approval; prompt painted before raw mode; old certificate copy; old pairing-only handoff. Exact source bytes restored; final focused run passes again.

Product, final tests and harness were pinned at clean `eeae77d272f5301717d54704d75b73d792be685e` before the final container run. `container/inputs.json` binds that commit/tree, individual inputs and every compiled file through deterministic full-tree digests; `container/container-artifacts.json` independently matches both container copies (**2734 files each**). Later evidence-only commits do not claim a new product execution. Earlier modified-tree/harness-debug runs remain private and are not used as final capture provenance.

## Real terminal, disposable container

`bash scripts/manual/hub-wizard-bugs-2917/rehearse.sh` passed **20 PTY cases**: baseline/candidate × EN/zh-TW × the five contracts above. Captures are under `container/{base,candidate}-{en,zh-TW}/`. Node **22.23.3**, Ubuntu **22.04.5**, source builds; this is not an installed npm release or a real AD/OS trust test. The baseline at this source revision exits **0** after fingerprint Enter; it still loses all answers. The older UX review observed exit 1 on its different installed build.

The real CLI uses a private unprivileged account and separate AGEND_HOME per case, real raw-terminal input, generated certificates and a container-loopback fake LDAP service lookup. The password-method correction and complete initialization reach the real sealed initializer. No service is installed or started, no personal password is used, and no real directory, account, Fleet or Mac pilot is touched. This does not exercise company-join browser behavior; only its final setup instructions change.

The candidate secret case checks that the misplaced canary and legitimate fixture password are absent from output, handoff and shell history; the canary is absent from all generated files. Only the intended `hub/secrets/directory-bind` contains the exact service-password bytes, mode **0600**. The fixture password is generated inside the container and read by the host PTY driver in memory; it never enters argv or shell commands. The deliberately echoed **baseline** canary is replaced with `<ECHOED-SECRET-CANARY>` in stored captures. ANSI/CR are removed; build/test logs replace only the development checkout path with `<checkout>`.

The owned container has `--network none`, no published ports, host mounts or privileged flags; it bypasses systemd. Host netns and binfmt listings compare equal, including WSLInterop. The trap removes its own container and temporary baseline tree; the Lumen review container is untouched.

## Scope, risk and rollback

The repeated CA step adds no approval and preserves the exact fingerprint/CA trust gates. Directory lookup, credential binding, final owner confirmation, signed state and interrupted post-confirmation initialization resume remain unchanged. Pre-confirmation answers are retained **in memory while retrying**. Explicit quit, Ctrl-C or a process crash before confirmation still discards those answers; no new persistent draft containing secrets is introduced.

Revert this source patch to return to the previous prompts and wording; there is no schema/data migration. Existing successfully initialized Hubs are unaffected. The PR is alpha-only and remains held for the alpha.14 release freeze; author does not merge or upgrade the pilot.
