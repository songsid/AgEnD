# Readable chat login picker

`TelegramAdapter.notifyAlert` appended every choice to the same `InlineKeyboard`
row. `FleetManager.promptLoginBackends` also put backend identifiers and all
status details into each label. Seven long labels therefore competed for one
row. Both main and the dev branch contain this code.

Telegram login alerts now start a new row after two buttons. Other alert types
keep their existing layout. The backend picker uses short display names, with
the same installed/configured/next-step details in the reply above the buttons:

| Row | First button | Second button |
| --- | --- | --- |
| 1 | Antigravity | Claude |
| 2 | Codex | Grok |
| 3 | Kiro | Muse |
| 4 | OpenCode | |

Discord's existing five-per-row builder is unchanged: seven choices use rows of
five and two. Both builders retain each choice's complete callback identifier;
the backend actions, nonce generation, expiry and permission checks are unchanged.
The credential-profiles skill describes the new layout and status legend.

## Verification

On main base `053c4193fe7cc8c22a5d5fca15b95ee268dca631`, the new test produces four
semantic failures: row widths and readable labels in EN and zh-TW. The two
Discord controls and the unrelated-alert control already pass at base.

After the fix:

- The four focused files pass 43 tests and reveal two old assertions reading
  status from labels. Those assertions now read the corresponding reply lines;
  their selected rerun passes 2/2, with nine unselected tests excluded.
- The fleet-label suite passes 6/6, retaining the exact two-line chooser/Fleet
  header while allowing the status legend below it.
- The staged union is **51 distinct passing tests**. Source and test TypeScript
  checks both exit 0. Commands and stage counts are in
  [results](validation/results.json), with the [baseline failures](validation/before.log).

The test drives the real FleetManager chooser into a real Telegram adapter with
an inert `sendMessage` spy, then reads the actual `inline_keyboard`. It pins
`[2,2,2,1]`, all seven labels, the original `login:<nonce>:<backend>` values,
the shared nonce and Telegram's 64-byte cap. The actual Discord builder pins
`[5,2]` and preserves the same labels and callbacks.

Installed-backend probes, provider sends, login and install effects are stubbed.
Temporary files and adapter HTTP agents are closed. No live Telegram/Discord
account, API request, fleet start, CLI, browser or desktop window is used.
This packet proves the provider payload; it does not claim a native client render.

Risk: the reply is several lines taller because status details moved out of
the buttons. Callback behavior is covered by existing login-click tests. Revert
the change to restore the previous presentation; no stored data changes.
