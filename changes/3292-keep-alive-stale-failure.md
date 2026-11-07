---
section: Fixed
---
- **"Needs signing in again" no longer outlives the sign-in (#3292).** Keep sign-in alive kept the result of a check made while the account was signed out until the next daily check, so a row that said "signed in" still said, in red, `last check: needs signing in again`. That result is now ignored once the sign-in's own file holds a newer valid token (Claude Code and Codex); an expired, dead or missing sign-in keeps saying it. When a sign-in ends, AgEnD also asks for that one account's check at once, in the background, and it can never break the sign-in's follow-up.
