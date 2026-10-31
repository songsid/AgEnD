---
section: Fixed
---
- Web dashboard: pages opened over your permanent link (`web.public_link.hostname`) no longer call it a "temporary public link". The Settings refusal, the custom-CSS note and the authorization reason now say "a public link". The session hint now gives the real limit, which is the same for a temporary link and your permanent link: at most 8 h, ending after 30 min idle, and never outliving the link itself. An admin's session also never lasts longer than your session setting; a guest's follows the guest settings. It used to say 4 h.
