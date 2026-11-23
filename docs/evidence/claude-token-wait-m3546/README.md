# Token-helper waiting state

## Diagnosis and limits

The private setup-token transport retained raw output only in memory, then reduced its screen to a recognized sign-in URL and code-input hint. When the shared screen parser rejected the output, or did not recognize it, the reducer returned an empty string. The surrounding sign-in controller therefore saw no unsupported screen: its five-second unknown-prompt grace requires nonempty input. The only remaining deadline was the ten-minute session limit.

The root fix removes complete APC control strings before the existing VT stripper, in both screen parsing and completion-token extraction. Incomplete strings remain unrecognized; the parser still rejects remaining escape characters. Opaque control payloads never become visible authentication text.

This change also preserves **only the presence** of an unknown screen as a fixed, code-owned marker. No private screen text is returned. The existing five-second detector now ends the helper, closes its resources and releases the login slot. The web displays a specific EN/zh-TW unsupported-step error and explains the existing manual setup-token/paste fallback. It never answers a CLI prompt automatically.

The canceled user attempt left no live helper process or socket to inspect. The named daemon log supplied no helper-specific lifecycle event. The cached Claude version was 2.1.330; it is not a proof of the exact original launch. No live login was retried.

## Offline evidence

A fresh empty-profile 2.1.330 control ran under a Linux network namespace with no networking. Its direct PTY output was recognized by the shared parser. Through the actual private-output transport and bundled tmux 3.8, the normalized stream retained an APC Kitty graphics query (`ESC _ G … ESC \`) and was rejected by the shared parser, despite containing authorization-screen text. Node's `stripVTControlCharacters` removes common CSI/OSC display controls but leaves this APC opener and its ST terminator. Removing the complete opaque APC before that utility lets the same transport expose the recognized authorization/code screen. The old reducer would turn that rejection into an empty wait. This is a reproducible failure class, not a recovered copy of the canceled user's screen or a claim that a theme wizard was its cause.

Only booleans, counts, parser phases and software versions were inspected or retained. No sign-in URL, authorization code, token or raw output is in these artifacts. Every owned helper was closed; no provider connection, real account or model request was used. The fix does not loosen provider URL/screen checks or claim to support every terminal-control variant.

## Regression

`tests/claude-token-unknown-m3546.test.ts` feeds the real private transport from the existing recorded `claude-2.1.318-onboarding-theme.pane.txt` fixture. That is a known unsupported screen for this helper, not a fixture from the user attempt. It asserts:

- waiting and no key/credential commit before the five-second grace;
- `failed / unsupported_prompt` at the deadline;
- no raw fixture text or secret output in the returned view;
- private transport cleanup, scratch removal and login-lock release.

The expectation fails on the base (still waiting at five seconds). A second red-on-base fixture records the 2.1.330 APC framing through the private transport; its graphics data and authorization URL are replaced with synthetic values, and other output is omitted. It now parses the authorization/code screen. A split-control regression refuses an incomplete APC, removes its opaque payload when complete, and then accepts only the visible synthetic authorization URL. The test uses a controlled monotonic clock, not a longer timeout or retry. Existing recognized-URL, token completion, cleanup, cancellation, ownership and profile-switch tests remain intact. Mounted EN/zh-TW tests assert the concrete error, no waiting text, re-enabled helper button and no saved-credential callback.

After the fix, the isolated production transport returned `authorization` with a safe link present and confirmed cleanup; the unmodified Node-only normalization still failed on that same stream. The five focused files pass 145 tests.

Run the focused suites with `node_modules/.bin/vitest run tests/claude-token-unknown-m3546.test.ts tests/claude-setup-token-m3419.test.ts tests/web-claude-setup-token-m3419.test.ts tests/structured-signin-2599.test.ts tests/cli-upstream-precheck.test.ts`.

## Risk and rollback

A genuinely unsupported private screen now ends promptly instead of waiting for the outer deadline. A temporarily incomplete redraw still receives the existing grace period. The recorded APC-bearing sign-in screen now parses, while URL allowlisting and completed-token proof remain unchanged; no credential schema or storage migration is added. Revert this change to restore the prior waiting behavior. A successful real-account retest remains the user's step, with a separate explicit go-ahead before any operator-assisted vendor login.
