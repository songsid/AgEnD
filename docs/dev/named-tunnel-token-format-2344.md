# Named tunnel token format (#2344, item 8)

PR #2354 fixed walkthrough items 1–7 and deliberately left this check unchanged.
The old predicate only bounded the string and checked its alphabet. It already
rejected spaces in full commands and surrounding quotes, but accepted arbitrary
base64-looking garbage. Quoted credentials also could not be saved.

Cloudflare's [TunnelToken structure](https://github.com/cloudflare/cloudflared/blob/9c49bb94af65fb9be7cf1ae9165850a8a333fbba/connection/connection.go#L72)
uses `a` for a string account tag, `t` for the tunnel UUID, and `s` for a
base64-encoded byte secret. An endpoint `e` is optional. This is a base64-encoded
JSON object, not a three-part JWT.

One bounded parser now removes surrounding whitespace and one matching pair of
single/double quotes, accepts a single base64 or base64url string, decodes strict
UTF-8 JSON, and checks the required fields: a nonblank account tag, a UUID and a
nonempty standard-base64 secret. Optional endpoint values must be strings.
Unknown fields are tolerated as cloudflared's JSON decoder does. It does not
contact Cloudflare, authenticate the credential, or display decoded fields.
Commands, flag prefixes, multiple tokens and malformed input are rejected rather
than searched for an embedded credential. The input limit remains 4096 characters.

The returned credential uses standard padded base64, matching cloudflared's
encoder/decoder. The same parser feeds the secret challenge, `.env` apply,
named configuration reader and child environment. No token is put in argv.
The API returns a fixed format-error code and English hint; the web card maps
that code to an English or Traditional Chinese hint, clears the password field,
and allows retry. It never displays backend error details. Existing confirmation,
0600 storage, clear behavior and quick tunnels are unchanged.

Tests construct synthetic credentials at runtime, including quoted and base64url
forms. Unit cases cover command/prefix pastes, invalid encoding/JSON/field types,
missing fields and length bounds. Real FleetManager transaction tests cover
normalized storage and rejection before challenges, logs, disk or network.
Stub-cloudflared tests cover env normalization and token-free argv. API/UI tests
cover safe errors in both languages and retry. All local heavy jobs are memory
capped; no real tunnel, provider, fleet or tmux operation is used.

Risk: this is a local format check, so a well-shaped revoked/incorrect credential
still requires Cloudflare's authentication when opening. Previously saved garbage
will now fail closed; Set token with the connector token repairs it. Normal
existing Cloudflare tokens remain valid. Rollback is a normal revert; secret and
configuration formats do not change.
