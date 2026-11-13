---
section: Changed
---
- The reminders AgEnD gives every agent now say what to do. A delivery that shows `uncertain` "may already have arrived: check it with `delivery_status`, then confirm (or resend only if it shows `failed`)". This wording is the same in the agent instructions, the `delivery_status` tool, the agent CLI reference and the status text. The reply-required and reply-pending prompts ask for what was done, the result and the next step. The inbound hint reads "(Answer with the reply tool; terminal text does not reach them.)". The rules themselves are unchanged: check before any resend, resend only after `failed`, answer users through the reply tool.
