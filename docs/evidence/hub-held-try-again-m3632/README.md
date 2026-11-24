# M-3632: Needs you → Try again on held Hub work

Real browser and the real web handlers, on the repo's scratch dashboard fixture (`scripts/manual/smoke-fixture`). No Fleet, CLI, Hub or tunnel is started. The Needs-you list holds two held Hub questions for one agent:

- **4 min ago:** never reached the agent; the Hub only could not answer, so the member offers Try again.
- **9 min ago:** refused by the Hub, so Try again is not offered.

| File | What it shows |
|---|---|
| `*-before-1-held.png` | release/2.3.5-alpha acf22f6dc: both held items show only **Open chat**. There is no way to release them. |
| `*-after-1-held.png` | This PR (sources below): the retryable item explains what happened and shows **Try again** / 「再試一次」. The refused one does not. |
| `*-after-2-tried.png` | This PR (sources below), after pressing Try again: "Asked the Hub again." / 「已重新詢問 Hub。」, and the button stays off until the list refreshes. |

Variants: desk en light, desk zh-TW light, phone en dark, phone zh-TW dark. The agent names are the fixture's.

On the server, Try again sends the question back through the member's whole hand-off, including the Hub's begin lease. See `tests/hub-representative.test.ts` (M-3632).

Exact sources of the captures:
- before: acf22f6dc (the base).
- after, en (desk-en-light, phone-en-dark): cc4c22187.
- after, zh-TW (desk-zh-TW-light, phone-zh-TW-dark): fdf9f38c0, which carries the reviewed zh wording.

Later commits change only how the button's claim is kept (per hold, Prism on #4410), not what is drawn.
