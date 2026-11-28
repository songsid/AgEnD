# M-3783: the allowed-contacts editor on a phone (real app)

The editor is "Set allowed contacts for these people" (「設定這些人的常用轉交」), opened from a contact request. The #4497 captures found two problems on a phone. The explanation sat behind the footer buttons (取消 / 核准…), and the paragraph was dense.

#4497 already made the body scroll between the head and the footer. It has `min-height: 0` and room after its last line. This change shortens the text:

- **One line under the route:** "Until it expires, these people's requests of this type are forwarded to this agent without asking." (「到期前，這些人的這類請求會直接轉交給這個 Agent，不再詢問。」)
- **The rest, folded under What this allows (「這會允許什麼」).**
  - It covers only this source, this agent and this request type.
  - The rule only decides whether a message is forwarded; the receiving agent still follows its own permissions.
  - To undo it, remove the rule in Permissions.
  - When several people are in the conversation, a later request skips approval only if each of them has a matching rule.
- **The several-people line** is now just the instruction: "tick each person the rule is for".
- **Phone polish.** The save button reads "Approve and allow from now on" (two lines on a phone), and its zh label 「核准這筆，並設為常用轉交」 breaks only at the comma. The title wraps evenly, and the fold keeps its ▶ marker with a full tap height.

The script is `scripts/manual/request-contact-card-s228/capture.mts` (#4497's). It ran at `61c5de308` (`src` clean) and passed 182 of 182 checks. `receipt.json` lists the editor's 34 checks and each PNG's sha256.

| Frame | What it shows |
|---|---|
| `*-5-always-allow` | The editor as it opens. The short line comes first, What this allows is folded, and the save button is off until someone is ticked. |
| `phone-*-5b-always-allow-end` | The same editor scrolled to its end. Its last line sits fully above the fixed footer. |
| `phone-*-5c-always-allow-more` | What this allows opened, and readable. Scrolled to the end, the body still ends above the fixed footer. |

The phones are captured in light en and dark zh-TW, and the desk in light en and dark zh-TW. On the desk, the editor is unchanged apart from the shorter text and the fold.

The new words are registered by the editor itself (namespace `cgrant`), so a tab holding an older `contact-auth-strings.js` still reads them. The shared `grantBoundary` and `grantAllOrigins` keep their release text, so an older editor still shows the full explanation. `tests/grant-editor-skew-m3783.test.ts` covers the mixed pairings.
