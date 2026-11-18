# Classic CLI guard evidence

The isolated real-binary matrix proves the native policy for Linux x64 Claude
Code **2.1.295 and 2.1.327**, in MCP mode. Other versions, operating systems,
architectures, CLI mode and other backends report not-covered. No account,
provider, live Fleet, pane, browser or user configuration was used or changed.

The fixture contains 41 observations: 20 per covered version and one 2.1.294
negative control. Each CLI ran with a fresh HOME inside a private network and
mount namespace. Only dummy APIs and dummy MCP servers existed there. A
test-only certificate/proxy made the WebFetch domain check and public page
available inside that namespace; it does not change production trust.

| Observation, per covered version | Result |
| --- | --- |
| Exact AgEnD reply and selected external lookup | One dummy MCP call each |
| Native WebSearch and WebFetch | Local fixture answer, no tool error |
| Another tool on the selected server; an AgEnD admin tool | Refused, zero MCP calls |
| Bash, Read, Write, Agent | Refused; no file effect or subagent |
| Hook missing, crashing, timed out after actual load | onFailure block; zero MCP calls |
| Hook missing at startup | No verified load and zero model requests |
| Policy invalidated during a turn | Restart-required, zero MCP calls |
| Production backend prepare/write/build launch | Verified load and one reply |
| User/project MCP and disabling-hooks settings seeded | Only bound/selected servers start; guard stays loaded |
| Public reading switched off | Native search refused |
| Owner-level selected stdio definition and warning | Snapshot only that server, one permitted call |
| Repository-only selected definition | Not-covered; public search still works |

2.1.294 is deliberately run with the newer hook setting as an upstream control:
after the hook is removed, the dummy reply **executes**. The product refuses to
claim coverage for that version. This proves why the documented 2.1.295 failure
contract is required, rather than treating an ignored option as protection.

Stages are retained separately. The initial 26-case matrix had two fetches
refused by the isolated network's missing domain-check service. Those two are
excluded from the accepted fixture and replaced by the successful proxy-backed
retake. A first successful fetch retake exposed an unclosed mock CONNECT socket;
the final retake closes it and exits 0. No product repair was needed for either. A supplemental owner-missing run initially used the fetch-answer assertion for a successful search; the corrected scoped run passes. The inherited-server retake also seeds the config-dir-specific global file used by the real CLI.
The later source delta narrows binary/architecture coverage and adds incomplete
inventory metadata. Owner-resolution and clean hook-environment changes have
scoped real-CLI retakes; the unchanged core matrix is retained without repetition. CLI-reported cost is calculated from dummy responses, not a charge.

The first offline test failed against the original launch's permission-bypass
command. Focused controls include the real stdio MCP menu/call boundary,
daemon status port, path quoting, stale/current receipt and file tampering.
Reversals removing the tool allowlist and current-launch checks each fail their
semantic test, with exact source restoration afterward.

Replay with retained real binaries, a fresh output directory and no account:

```sh
CLAUDE_294=/path/to/claude-2.1.294 \
CLAUDE_295=/path/to/claude-2.1.295 \
CLAUDE_327=/path/to/claude-2.1.327 \
GUARD_RIG_OUTPUT=/path/to/fresh-owned-directory \
bash scripts/manual/classic-cli-guard/run.sh
```

Use `GUARD_RIG_CASE=missing-hook GUARD_RIG_VERSIONS=2.1.294` for the minimum
version control. The regular invocation covers both supported versions.
Do not publish raw homes, certificates, private keys, downloaded binaries or
unsanitized captures. The committed observations retain only synthetic tool
results and generic rig paths.

Limits: these are launch/tool policy controls, not OS isolation from a process
under the same user. Legacy native tool inventories remain unavailable; the
status says `impactComplete:false`. Account-backed MCP selections require an
explicit cost/identity warning. Actual delivery admission and contact grants
remain the separate A1 server policy. No Codex native guard is claimed.

The later WebFetch follow-up adds an offline literal-target check: file/other
schemes, userinfo, explicit private/local/special-use IPs and internal hostname
forms are refused. The new semantic test is red before the check and the four
guard suites pass 15/15 afterward. The 41 real-CLI observations remain frozen
at their recorded stages; they do not claim a new network campaign for this
follow-up. The public URLs used by those fixtures remain admitted.

This check does not resolve/pin DNS or inspect connected addresses and
redirects. A public-looking hostname or redirect may reach an internal service;
selected MCP tools retain their own network/data behavior. Existing transcripts
and memory are preserved, so old information may still be known. The guard is
not an internal-network isolation or data-erasure guarantee, and it adds no
ordinary-worker action gate.

The A1 integration follow-up preserves a frozen native launch for contact-only
revision changes, fences a launch overtaken by a native policy change, and
reports restart-required when a running room leaves restricted mode. Two new
policy-port tests are red before the correction; the four guard suites pass
17/17 afterward. No real CLI observation was replaced or added for this change.
