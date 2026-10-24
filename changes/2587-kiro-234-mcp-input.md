---
section: Fixed
---
- **kiro-cli 2.34.0: a message is no longer delivered into kiro's new "Input requested" card (#2587).** In 2.34.0's V3 engine, when an MCP server's tool asks you for input (a form, or a sign-in link), kiro replaces its input box with a card. AgEnD read that screen as an idle input box, so the next message was pasted into the card: the text was lost and its Enter accepted or changed whatever field was selected. The card is now held. No message is delivered and no key is pressed until you answer or cancel it in the instance's pane, because the answer can be a credential or a sign-in. Every other kiro 2.34.0 launch screen is unchanged from 2.33.1 (re-captured live), and 2.34.0 no longer gets the "untested version" launch warning.
