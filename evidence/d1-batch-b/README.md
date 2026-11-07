D1 batch B evidence only. Main PR #3381; alpha PR #3382.

All screenshots use isolated web fixtures, synthetic state and mocked actions, no real account or fleet lifecycle. Main has no account/device management modules; alpha covers the account logout error and in-page retry.

Before/after: desktop/phone × light/dark × EN/zh-TW. `manifest.json` binds both heads, changed-file SHA256, core browser checks, focused retention captures and PNG counts. `before-*` serves the baseline UI modules with the candidate server to check stale-module compatibility; new modules also translate the old setup-cleanup response and sign-out warning. Fully cached old modules keep their own wording until reload.

Existing shared Dialog, authorization tooltip, Settings note and sign-in message; no styles or additional confirmations.
