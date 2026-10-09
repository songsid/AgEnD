---
section: Security
---
- **Web app: the panels' security policy can no longer lose its script nonce or image source silently (#1527).** The policy each panel is served with now extends whole directives of the base policy, and AgEnD refuses to start if one is missing, instead of serving pages whose scripts or Discord emoji images would be blocked.
