---
section: Added
---
- **Settings → Accounts: "Cancel sign-in and remove" (#3212).** Remove was refused with nothing to do about it while the account's sign-in was running. After that refusal the dialog now offers **Cancel sign-in and remove**, which ends the running sign-in of that account and then removes it, in one request with the same typed name; another account's sign-in is never touched. It is offered only for an account on this host, and only after that refusal.
