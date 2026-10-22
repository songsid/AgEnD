# #1939 Verified web sessions

Status: target 2.3. **Amended 2026-10-18 (§0): a session is authenticated once; there is no per-action step-up.** §0
is the design in force (simplified the same day: §0.1), and §1, §3, §4 and §7 are rewritten to match it. §5, §6 and
§11's decisions 4–6 are superseded and kept below only as the record of what was considered. Where §8 or §10 still
says "step-up", read "the session's authorization". S1 (#2108) is merged; §0 says what changes in it.
**Amended 2026-10-22 (§0.2, #2453): an opt-in, off by default, lets a session on the admin's own named-tunnel hostname
be authorized too.** Quick tunnels are unchanged.

## 0. Amendment (2026-10-18): authenticate the session once

**The user's decision.** Both are Discord receipts from the user, read with `delivery_status`: delivered, owned
`proof_kind`, origin `discord` / `368442276000694273`.
- `hmsg-d6b0a106-7c45-4fa5-8f5b-793e93d124d8`, the request: "1939 可以改成授權後=我本人discrod / 用原本查訊息id的方式就好嗎 /
  只要auth ,不用改成收束權限" (once authorized, it is me on Discord; check it by message id as today; only auth, no
  per-action narrowing).
- `hmsg-1f07e1fd-d855-4c5a-9205-6172f5c2fa05`, a confirm button: "對，照這個改（整個 session 認證一次）" (yes, change it
  to this: authenticate the whole session once).

**The model.**
1. **Authorize once.** A session that qualifies under §3 is authorized once. §3 means: a cookie session, admin tier,
   the local surface, a current token epoch, a bound account still in its adapter's `allowed_users`, the target on that
   adapter, the `loopback_only` rule, never the public link.
   - **How:** the person presses **Authorize this browser** in the app. It is on the session menu, and on a
     "Not verified" chip by the composer.
   - **Confirming:** AgEnD posts a Confirm card to the account the session's sign-in code went to, in that account's DM.
     **Confirm** authorizes **that session** (its handle). **Not me** denies it and signs that session out at once.
     - **If a DM can't be sent,** that adapter's General gets only a line with no details ("open your DMs, then press
       Authorize again"). The card, with its account and device, is never posted where others can see it.
   - **The claim:** only that account can press either button.
   - **What is kept:** an authorization is a record beside the fleet (`web-authorizations.json`, owner-only), keyed by
     the session's handle, holding the account that gave it, when, and the revocation epoch it was given under.
     - It survives a restart while its session lives.
     - An epoch bump ends every one at once.
     - Losing the file only loses authorizations; the person authorizes again. It can never grant one.
2. **After that, the session speaks as the account.** Each message, reply-button click, `/steer` and `/btw` from an
   authorized session gets a human receipt equivalent to one from Discord or Telegram:
   - its own `verification_id`;
   - delivery evidence (`state`, the owned `proof_kind`) exactly as today;
   - `authority.kind: "web-verified"`, with the linked account as `authority.actor` and the session in `authority.session`.
   - Receivers verify it with `delivery_status` the way they verify a platform message, and grant it onward with
     `forwards` as any `hmsg` receipt.
   - `HumanOrigin.platform` stays `"web"`, so it is never mistaken for a platform message.
3. **It ends at the earliest of these.** After that, the session's new messages carry no authority:
   - `max_session_hours` after the authorization (1–48, default 48);
   - the session ending (expiry, sign-out, `/web revoke`, a token rotation);
   - the server switch turned off;
   - `loopback_only` turned on (for `lan` sessions);
   - any revocation epoch bump.

   **Receipts already written** keep their authority as evidence, the way a Discord message stays a Discord message
   after its sender logs out. They read as `none`, with `downgraded`, only on a revocation, which is §10's rules,
   unchanged: `/web revoke`, the switch off, `loopback_only` on (for `lan` receipts), or any epoch bump. The
   authorization state never moves behind the receipts (#2112: a missing or rolled-back state file revokes).
4. **A qualifying session that is not authorized** carries `none`: recognition only, as all web traffic before #1939.
   S1's observe-only `web-session` value is read as `none` from here on. It was never an authorization, and the first
   time the switch turns on, the epoch moves past it anyway.
5. **Dropped:**
   - the per-action step-up;
   - the enforced action list and custom actions (`step_up` in fleet.yaml);
   - binding to a message's text;
   - the executor list (§11's open question);
   - S4's agent card.

   Settings → Web → Web authority keeps four controls: the switch, "Only this computer can authorize", the hours, and
   Revoke web authority. It also lists the authorized sessions. §0.1 drops more.
6. **The instructions (S3)** replace every "web grants nothing" rule with one: a `via web (verified)` message is a human
   receipt; verify it with `delivery_status` (require `authority.kind: web-verified`, delivered, an owned `proof_kind`,
   the content and the actor) the same way as a Discord or Telegram message, and forward it with `forwards`.
   **Reworded by the user, 2026-10-19 (Discord receipt hmsg-45b6a366):** a plain `via web` message from a signed-in
   user is that person for ordinary requests (questions, reading, analysis, work in the agent's own scope); only a
   go-ahead action (a release or publish, destructive or irreversible, spending beyond normal work, credentials or
   secrets, granting or forwarding authority) needs a Discord/Telegram receipt or a checked `via web (verified)` one. A
   guest only chats; revoked authority and a reviewer's APPROVE are no go-ahead. The text is `WEB_RECEIPT_RULE`.

**Staging (replaces §10's S2–S4).**
- **S2a, server: #2112, reworked before it merges.**
  - **Kept:** the switch, the revocation epoch, and #2112's restart and rollback fixes.
  - **Removed:** `step-up-policy.ts`, fleet.yaml's `web.verified_authority.step_up` and its validation, and
    `delivery_status`'s `step_up_policy` field.
  - **Changed:** `authority.kind` becomes `web-verified`, written only for an authorized session. S1's `web-session` is
    read as `none`.
  - **Added:** the session-authorization store.
- **S2b, the Confirm card** (§0.1): Authorize this browser, the card with Confirm and Not me, its limits, the
  in-app states, and the audit events.
- **S2c, Settings.** The four controls and the authorized sessions; the switch on by default (§0.1).
- **S3.** The instructions and the `via web (verified)` header label.

The receipt model of §4 keeps `authority`. The `step_up` field is not written.

### 0.1 Simplified (2026-10-18): only the gates that stop a named threat

**The user's decision** (fleet decision a94a1bab, relayed by the leader): 「後續要減少這種過度設計權限」 (from now on,
cut this kind of over-designed permission). The rule: keep the simplest design that holds the real boundary; every
consent step, switch, origin restriction or precondition names the concrete threat it stops, or it goes; prefer "works
by default, with a visible off switch".

**The real boundary** is the account's own click: a session gets authority only after the account it was signed in as
presses Confirm in its own Discord or Telegram. A stolen cookie therefore cannot speak as the person.

**Changed:**
- **The switch is on by default** (`web.verified_authority.enabled`), with a visible off switch in Settings. On by
  default exposes nothing: no session carries authority until its account confirms. Off is the server-wide kill
  (§10), unchanged.
- **The Confirm card is the only way.** The DM code is dropped: a code typed into a page is the one phishable step,
  and a click in the person's own Discord isn't. With it goes the separate `/authorize` document and §6.5's isolation
  rules. That isolation stopped a page restyled to fake a code prompt, and there is no code to fake any more.
- **No Settings confirmation for these keys.** Turning the switch on, turning `loopback_only` off and a longer
  `max_session_hours` grant nothing by themselves: a session still needs the account's click. They apply at once. A
  Settings write still needs an admin session.
  - **The hours never stretch an authorization already given.** Each authorization keeps the end it was given with
    (`authorizedAt + max_session_hours` then). A shorter setting shortens it, but a longer one only applies to
    authorizations given afterwards. So a stolen, already-authorized admin session cannot extend itself by raising the
    hours.

**Kept, each with the threat it stops:**

| Gate | Threat |
|---|---|
| The account's Confirm, once per session | A stolen cookie speaking as the person |
| §3's checks per request | A guest, the public link, a non-admin, a rotated token, another adapter's account |
| `loopback_only` (off by default) | A dashboard listener reachable from an untrusted network, for those who want it closed |
| The revocation epoch, `/web revoke`, Revoke web authority | Recovering after a theft |
| `max_session_hours` | An authorization left standing long after it was needed |

**Against confirm fatigue**, the one risk the card adds: someone with a stolen cookie pressing Authorize again and
again, hoping the person taps Confirm.
- **The card says exactly what it authorizes:**
  - "this browser";
  - its surface (this computer, or the network);
  - a coarse device label from the browser's own description;
  - the time asked, and when the authorization would end.
- **One pending request per session**, and at most **3 requests an hour per account**. The app explains a refusal.
- **A card expires** 5 minutes after it is posted, and is marked expired where it sits. A tap that comes later does
  nothing.
- **Confirm is judged at the moment of the tap:** AgEnD reads the session again by its handle and runs §3 again. It
  refuses, and says so on the card, if:
  - the session has ended;
  - its token has rotated;
  - the epoch has moved;
  - the account is no longer an admin;
  - the switch is off.
- **Not me** denies the request and signs that session out at once, so a theft ends with one tap.
- **After Confirm, the card stays as the notice:**
  - it reads "Authorized: this browser (…) until <time>";
  - it keeps a **Not me** button that signs the session out and ends its authorization for as long as the authorization
    lasts;
  - so a mistaken Confirm still has one tap to undo it.

**The from-defaults smoke** (fleet decision a78ebdc5) goes the whole way: a fresh profile signs in, sees "Not verified",
presses Authorize, gets the card (the DM stubbed), and Confirm turns it verified. It also covers Not me (signed out),
the limits, and the blocked states: the public link, a guest, the switch off.

### 0.2 The admin's named link (2026-10-22, #2453): opt-in, off by default

**The request.** The user asked (2026-10-22, relayed by the leader with its Discord receipt) for **Authorize this
browser** on the admin's own fixed hostname: a named tunnel, `web.public_link.hostname` set (#2321). Until now every
public-link request or session was refused (`public_link`, §3.5), the admin's own hostname included. The constraints
are the issue's. Each gate below names the threat it stops (§0.1's rule).

**The option.** `web.verified_authority.named_link: true`, off by default. It sits with the other three web-authority
keys, and in Settings → Web → Web authority as "Also over my named link (<hostname>)". The row is shown only while a
named link is configured.
- **Turning it on needs a fresh, independent confirmation.** That is the Confirm card in an eligible General, or
  `agend settings confirm <id>` on the host. It is never the requesting session's own authority. This is unlike the
  other three keys (§0.1).
  - The threat it stops: a stolen web session (local or public) opening the internet path by itself. A stolen cookie of
    an **already authorized** local session is the case that matters here.
  - The other keys are reachable only from networks the user already trusts. This one is the only switch that makes a
    session reached from anywhere on the internet able to qualify. That one step needs a second party's yes.
  - **Never self-confirmed (#2170).**
    - **The rule.** A held change whose effect turns `named_link` on (from false or unset to true) is never confirmed by
      its requester, whether alone or among other keys. `settingsSelfConfirmation` returns null for it, so it goes to a
      General's card, or to the host CLI when no card can be asked.
    - **What is judged.** The trusted effect: the diff that `prepareSettingsEffect` computes from the config before and
      after. Never the request body.
    - **Until then.** Nothing changes: no config write and no epoch bump until that independent decision.
    - **Everything else is unchanged.** Every other self-confirmable change keeps #2170's behaviour.
  - **A named-link session is never the self-confirming authority (#2170) either,** for any held change. #2170's own rule
    already says "a public link never qualifies". Until now that held because `evaluateWebAuthority` refused every
    public request. With this option on, a named-link session can be `web-verified`, so the exclusion is stated and
    enforced on its own: `settingsSelfConfirmation` requires a request that is not on the public link (no gateway
    context) and a session whose peer is not `named_link`. A Fleet or Advanced write an admin makes over the link
    (allowed since 2026-10-22) still waits for a General's card or the host CLI, as before.
- **Turning it off applies at once,** with no confirmation, like every narrowing.
- **It can't be changed over the public link.** `web.verified_authority` is written only by
  `PUT /api/settings/fleet/web`. That route is refused over the public link twice: in the confirmation gate, and again
  in the handler (`web_settings_not_over_public_link`).
  - `web.appearance` has its own route, which is refused over the link as well.
  - The Fleet and Advanced writes an admin may make over the link (2026-10-22: defaults, channels, instances, apply)
    can't reach `web.verified_authority`.
  - The implementation adds a test that pins this for `named_link`.

**Which requests qualify (§3, item 5 amended).** A request over the public link qualifies only if **all** of these
hold, in addition to every other §3 check (cookie session, admin tier, current token epoch, bound account still in
`allowed_users`, same namespace, switch on, authorized by the account's Confirm):
1. **Named, by listener provenance, on the exact hostname.** The request's gateway context (`GatewayRequestContext`)
   says **named**. The gateway binds that value to each request it admits, and it is true only when both hold:
   - the gateway was created with the named settings;
   - the host it has pinned is exactly the configured hostname (`publicTunnelHostname(web.public_link.hostname)`).

   `setHost` today also accepts any `*.trycloudflare.com` name on a gateway that has a hostname. A request admitted
   under such a host is **not** named. No header can set or change the value, as for `surface` today: Host,
   `Origin`, `X-Forwarded-Host` and the other forwarding headers are never read for it, and the gateway already
   refuses a Host other than the pinned one. A quick tunnel's context is never named, so it is refused as before,
   whatever the option says. An exposure keeps the mode it was created with: changing the config to named does not
   make an open quick exposure named.
2. **The option is on** (`named_link: true`), read at each request.
3. **`loopback_only` is off.** "Only this computer can authorize" still wins, because a request over a tunnel is never
   `loopback`.
4. **The session belongs to the current exposure.** This is today's gateway check: `exposureId` matches, and the
   exposure is open and current. An exposure is named or quick for its whole life, so a session made over a quick
   link can never become named.

**The peer value.** A qualifying request's `session.peer` is **`named_link`**, a third value beside `loopback` and
`lan`. It is set from the provenance, never from the TCP peer (cloudflared is local) or from headers. It shows:
- in the receipt (`authority.session.peer`), which `delivery_status` returns;
- in the audit events (§7), with the hostname;
- in the device list ("over your named link, <hostname>");
- on the Confirm card and in the notice DM: "this browser, **over your named link <hostname>** (the internet)". The
  person sees that it is not this computer or the LAN before they tap.

The `(verified)` header label is unchanged. The receipt says where the session was.

**The same ceremony, with no shortcuts.**
- **Confirming:** the account's Confirm card in its own DM; one pending request per session; 3 an hour; 5-minute
  cards; Not me signs the session out (§0.1).
- **Unchanged:** the token epoch, the revocation epoch and the server switch.
- **Lifetime:** the authorization ends at the earliest of these:
  - `max_session_hours` after it was given;
  - the gateway session's own end, at 4 h absolute and 30 min idle (the public link's fixed policy, which #2450 leaves
    alone);
  - any of the ends below.

**It ends with the link.** The public sessions, and the authorizations kept for them, end on any of these:
- **Close** of the link;
- **`/web revoke`**, which also bumps the epoch;
- **the link's expiry,** its TTL (#2450 allows a longer one, or none, for named links);
- **fleet stop or restart.** The gateway's exposure ends, so its sessions do; #2450's `auto_open` opens a **new**
  exposure, and the old sessions don't come back;
- **the option turned off.**

On each of these, the authorization records of those sessions are deleted from `web-authorizations.json`. Their
handles can never match again anyway, so this is housekeeping, not the barrier.

**Receipts already written.** `delivery_status` reads them as follows:
- **Option turned off:** every receipt whose `session.peer` is `named_link` reads as `none` with
  **`downgraded: "named_link_off"`**, at once.
  - Turning it back on goes through confirmation and **bumps the revocation epoch** in the same write. So, like
    `loopback_only` (§10), the older receipts never come back.
- **`loopback_only` turned on:** `named_link` receipts read as `none` with `downgraded: "loopback_only"`, as `lan`
  ones do.
- **`/web revoke`, the switch off, any epoch bump:** unchanged (§10).
- **Close, the link's expiry (TTL), fleet stop or restart:** these end the sessions and delete their authorizations,
  so their **next** messages carry `none`, the same way a local session ends by sign-out or expiry. **Receipts already
  written keep their authority as evidence** (§0, item 3), and `delivery_status` reads them as they were written.
  - **This amends #2453's acceptance line** "Close/revoke/option-off each downgrade it". By the leader's decision
    (2026-10-22, `xmsg-1792678618124-kvibrl` on `cid-1792678122608-75y4rj`: "Close/expiry end the sessions without
    downgrading receipts already written … /web revoke and option-off downgrade at once. No per-Close epoch"), only
    `/web revoke` and option-off downgrade existing receipts. Close downgrades the session. The issue carries the
    amended line.
  - **Nothing comes back.** A reopen, or #2450's `auto_open` after a restart, is a new exposure: the old sessions
    never authenticate again, and their authorizations are gone. Receipts are not affected by Close either way, so
    there is nothing to revive.
  - **After a suspected theft, revoke.** `/web revoke` or turning the option off downgrades at once. The Close
    notice in the docs says so.
  - **Why not downgrade on Close.** Downgrading on every routine Close or TTL expiry would refuse a person's
    legitimate go-ahead that was still being verified, and would stop no threat that `/web revoke` doesn't already
    cover.

**The refusal the person sees.** Over a named link with the option off, the chip reads "Not verified: over your named
link (turn on 'Also over my named link' in Settings on this computer)". Its reason is the new `named_link_off`. A quick
link keeps `public_link`.

**Threats this adds** (§8 has the rows):
- **The hostname is on the internet.** A cookie stolen from a browser that used the named link can be replayed from
  anywhere, with no network barrier.
  - **What stops it:** the account's Confirm, per session, still holds. A stolen cookie of an *already authorized*
    session speaks as the person until the 30-minute idle limit, the 4 h absolute limit, `max_session_hours`, Not me
    on the notice card, `/web revoke` or the option off ends it.
  - **This is the risk the admin accepts** when they turn the option on. The Settings row and the docs say so.
- **Cloudflare terminates TLS.** It sees the traffic, the session cookie and the CSRF token in the clear, and could
  replay them. Turning the option on extends to authority the trust the named link already places in the admin's
  Cloudflare account.
  - **Out of scope:** Cloudflare Access, or mTLS, in front of the hostname. They are compatible: the gateway still
    pins the hostname, and AgEnD's own sign-in still applies.

**Implementation (after #2450 merges, on top of it; its code is not forked):**
- `GatewayRequestContext` gains `named: boolean`, set by `public-web-gateway.ts` for each admitted request: the
  gateway was created with the named settings **and** its pinned host is exactly the configured hostname.
- `settingsSelfConfirmation` (#2170) returns null for a held change whose effect turns `named_link` on, and for any
  request on the public link or from a `named_link` session.
- `WebPeer` gains `"named_link"`.
- `evaluateWebAuthority` takes `named` and `policy.namedLink`. It refuses with `public_link` (a quick link),
  `named_link_off` (the option off), or `loopback_only`. Otherwise it continues through the same checks, with
  `peer: "named_link"`.
- The session-surface check accepts a gateway session only in that case.
- `authorityNow` adds the `named_link_off` downgrade. `AuthorityDowngrade` and `isHumanAuthority` accept the new values.
- Authorizations are deleted when the exposure ends.
- `settings-change.ts`: `named_link` turned on is a looser change, so it is confirmed, and it bumps the epoch;
  turning it off is immediate.
- The validator, Settings → Web authority (the row, shown in named mode only), the Confirm card and notice text, the
  device list, and the docs: SECURITY, web-dashboard and named-tunnel, EN and zh-TW.

**Acceptance tests (#2453).**
- **Refusals:**
  - a quick-tunnel session is refused (`public_link`), with the option on or off;
  - a named-link session with the option off is refused (`named_link_off`);
  - with `loopback_only` on, it is refused (`loopback_only`).
- **Authorized:** with the option on and after the Confirm card, the named-link session's message gets
  `web-verified` with `session.peer: "named_link"`, and `delivery_status` returns it.
- **Provenance, through the real gateway:**
  - Spoofed `Host`, `Origin` and `X-Forwarded-Host` / `Forwarded` never make a request named. A wrong Host is the
    gateway's 403, as today.
  - A named gateway whose pinned host is a `trycloudflare` name admits requests as **not** named, so they are refused
    with `public_link`.
  - A quick exposure stays quick after the config changes to named, until a new exposure opens.
  - Only the exact configured hostname is named.
- **Ends:**
  - **Close:** the session's next message is `none`, and the receipt written before Close still reads `web-verified`
    through `delivery_status` (this pins the leader's amendment).
  - **Reopen and `auto_open` after a restart:** the old session cookie is refused, and its authorization is gone.
  - **`/web revoke`:** that receipt reads `none` with `downgraded: "revoked"`.
  - **Option off:** it reads `none` with `downgraded: "named_link_off"`; turning the option back on (confirmed) doesn't
    restore it.
  - **Fleet restart with `auto_open`:** the old session is gone.
- **Settings:**
  - turning the option on returns a pending confirmation, not an applied change;
  - **an already web-verified local admin** turning it on, alone or together with an ordinary key, stays pending. It
    is not self-confirmed, and there is no config or epoch change until a General's card or the host CLI decides. The
    control: an ordinary self-confirmable change from the same session is still self-confirmed (#2170 unchanged);
  - **a `named_link` session** is never the self-confirming authority. Its held Fleet write over the link waits for a
    card or the CLI;
  - turning it off applies at once;
  - the write over the public link is refused.
- **Real smoke:** with a named hostname (a stubbed tunnel in tests; the real smoke on the admin's own hostname). No
  trycloudflare quick-tunnel smokes from the host (the decision on 429s).

## 1. Summary

A web session that qualifies (§3) is authorized once by the Discord or Telegram account that signed it in: a Confirm
card sent to that account only (§0, §0.1). From then on, its messages, button clicks, `/steer` and `/btw`
get their own owned authority, `web-verified`, bound to that account. Receivers verify and forward them as they would a
Discord message.

It lasts until `max_session_hours` after the authorization, the session's end or a revocation, whichever comes first.
A server-side switch turns all web authority off at once, whatever instructions a running agent has (§10).

Nothing changes for platform messages. A web session that does not qualify keeps today's meaning: recognition
only, no permission.

## 2. Facts this design builds on (origin/main 97160486)

- **Receipts.** `src/human-delivery-receipts.ts` has `HumanOrigin`:
  - `platform` is `discord | telegram | web`;
  - it carries `adapter_id`, `user_id`, `username` and `platform_message_id`;
  - `ingress` is `message | action | web`.

  `webHumanOrigin()` has every actor field null, so `delivery_status` shows `source_instance: "human:web:unknown"`.
- **What `proof_kind` means today.** It holds a `HumanPositiveTag`: `unique-id-pane`, `composer-empty-steer`,
  `composer-empty-queue` or `composer-empty-idle`. That is **delivery evidence**: the exact text reached the pane
  intact. It says nothing about who authorized it. `settleHumanReceipt` never checks the platform, so a web receipt
  can already be `delivered` with a proof_kind today.
- **Sessions.** `src/web-session.ts`:
  - `surface` is `local | gateway`;
  - `tier` is `admin | read` (`read` is unused);
  - the record has `created`, `lastSeen`, absolute and idle expiry, `tokenEpoch` and an optional
    `owner {adapterId, userId}`, taken from the DM recipient of the sign-in code (#1827);
  - local sessions default to 48 h (#1670), gateway sessions to 4 h absolute and 30 min idle.
- **What "local" covers today.** `surface: "local"` means the request arrived on the health listener. That includes
  LAN, tailnet and reverse-proxy hosts admitted by `web.allowed_hosts`. It is **not** a loopback check.
- **Sign-in codes.** `src/web-login.ts`: single use, 5 minutes, 5 tries, a breaker on repeated failures, delivered
  with `adapter.sendDirect`.
- **Settings confirmation.** `src/settings-confirmation.ts` posts a Confirm/Reject card and expires it after 5
  minutes. Who may decide is `settingsChatAuthority` (`src/fleet-manager.ts`): every adapter whose owner the change
  affects must be satisfied. `promptSettingsChange` may post in another eligible General, or fall back to the host
  CLI (`agend settings confirm <id>`).
- **The rules agents follow.**
  - `VERIFY_PEER_MESSAGE_RULE` (`src/instructions.ts`) ends with "Web has no verified platform actor".
  - The MCP Message Format says "`via web` is never a verified message from that account".
  - The same rule is repeated in `src/agent-whats-new.ts`, `src/agent-cli-instructions.md` and the
    `cross-instance-messaging` and `worker-collaboration` skills.
- **Two different gates.**
  - **The reviewer gate is mechanical.** `scripts/gate-merge.sh`, which the coordinator runs on a reviewer's
    APPROVE, checks the approval's delivery receipt, the approved head and CI before it merges.
  - **The human-consent gate is instructions only.** No code checks a *human* go-ahead before a merge, release or
    deletion. The consent rules (`VERIFY_PEER_MESSAGE_RULE`, the skills) are what agents follow.
- **A stale design claim.** `docs/design/web-unification-secure-login.zh-TW.md` lists D5 (`403 reauth_required` for
  risky public-link actions) as implemented (#1018), but no `reauth` exists in `src/`. The step-up here supersedes
  D5.

## 3. Which sessions qualify

A web session qualifies to be authorized (§0), and once authorized its message or click carries `web-verified` authority,
only if **all** of these hold **for the request that carries
it**. They are evaluated when the request arrives, again after its body is read (as the effect-trial routes already
do), and again when the session is authorized (§0). Nothing about locality is remembered from sign-in.

1. **The session.** It is a cookie session (`via: "session"`), not a header token, an `/view` reader or a CLI call.
   - `tier: "admin"`;
   - `surface: "local"`;
   - its `tokenEpoch` is current;
   - it is not revoked or expired.
2. **Bound account.** `owner` is set: the sign-in code went privately to that Discord or Telegram account. An
   `agend web --code` session has no owner, so it is the host operator, not a person with an account. It never
   qualifies.
3. **Still an admin, in the same namespace.** The owner `{adapterId, userId}` must name the adapter that owns the
   target instance (same `adapterId`, not just an equal user-id string), and that user must be in that adapter's
   `access.allowed_users`. This is rechecked with `adminGate(userId, adapterId)` on each request. Removing someone
   from `allowed_users` ends their web authority at once.
4. **Where this request comes from.** This is new. Each request is classified on its own, never from sign-in. A
   request is `loopback` only if all of these hold for that request:
   - it arrived on the health listener (`gatewayRequestContext(req)` is empty);
   - its TCP peer (`req.socket.remoteAddress`) is a loopback address;
   - its Host is in `LOOPBACK_HOST_NAMES`;
   - it carries **no** forwarding header (`Forwarded`, `X-Forwarded-For`, `X-Forwarded-Host`, `X-Real-IP`,
     `CF-Connecting-IP`, `Via`).

   Otherwise it is `lan`: a LAN or tailnet browser, or a reverse proxy.

   **By default, both qualify** (the user's decision). The class is still recorded in the receipt
   (`session.peer`) and in the audit log.
   - **The switch.** Settings → Web sign-ins has a switch, "Only this computer can authorize"
     (`web.verified_authority.loopback_only: true`). Turning it on makes only `loopback` requests qualify. Turning it
     on takes effect at once. Turning it back off goes through Settings confirmation.
   - **What `loopback` guarantees, stated exactly:** the request's TCP connection comes from this machine and names a
     loopback host. It does **not** prove which person sits at it. A local reverse proxy that strips forwarding
     headers is indistinguishable from a local browser, the same out-of-scope case as other local processes and
     users (A7 in the secure-login design).
   - **What `lan` means: only "not loopback".** The classifier does not check that a peer is on a private network or
     a tailnet. `lan` is everything that reaches the health listener and is not loopback. That includes whatever a
     port forward, a changed bind address, `web.allowed_hosts` or an ordinary reverse proxy exposes, and it can be the
     internet.
     - **What this design assumes.** The health listener is reachable only from networks the user trusts. The
       supported way in from outside is the public link, a separate `gateway` surface that never qualifies (item 5).
     - **What AgEnD enforces.** The only barrier AgEnD itself enforces against non-local requests is the "Only this
       computer can authorize" switch.
     - **The default.** A cookie stolen and replayed from any host that can reach the health listener carries
       ordinary authority. On a trusted LAN or tailnet that is the risk the user accepted. If the listener is exposed
       to the internet, the same holds for the internet (§8).
     - **The warning.** Settings → Web sign-ins warns when `web.allowed_hosts` names a host that isn't loopback while
       the switch is off.
5. **Never the public link, with one opt-in exception (§0.2).** A `gateway` session never qualifies over a quick
   tunnel, whatever the configuration. Over the admin's own **named** tunnel it qualifies only while
   `web.verified_authority.named_link` is on (turned on through Settings confirmation) and `loopback_only` is off. Its
   peer is then `named_link`.
6. **Freshness.**
   - **Authority lasts** `web.verified_authority.max_session_hours` (1–48, default 48) **after the session's
     authorization** (§0), not after sign-in. The sign-in time is not limited separately: the session store's own
     absolute and idle expiry (`web.session.local`) still end the session.
     - **Idle limit.** The session's own idle limit still applies, through `web.session.local.idle_hours`. A session
       the store has already expired is gone.
     - **Pre-touch activity.** An implementation that adds a tighter idle check must read activity from *before*
       this request: `WebSessionStore.authenticate` updates `lastSeen` before it returns, so authenticate with
       `touch: false` first, or capture `lastSeen` before the touch.
     - **An authorization that has run out** leaves the session working for reading and chatting; its messages simply
       carry no authority until it is authorized again.

A message that fails any check is delivered exactly as today, as recognition only. The composer shows a quiet chip,
"Not verified: <reason>", so the person knows why an agent may ask again on Discord.

## 4. The receipt model

**Don't overload `proof_kind`.** It already means delivery evidence, and receivers check it together with origin.
Putting authority into it would turn one field into two different questions. Instead, a human receipt gains a
separate, owned **`authority`** object. AgEnD writes it at admission; nothing in the message can set it.

```ts
interface HumanAuthority {
  kind: "platform" | "web-verified" | "none";
  /** The account that authorized it: the platform sender, or the web session's bound owner. */
  actor: { adapter_id: string; user_id: string } | null;
  /** web-verified only. The handle is the same opaque handle the device list shows. */
  session?: { handle: string; peer: "loopback" | "lan" | "named_link"; signed_in_at: string; authorized_at: string };
  /** The revocation epoch this authority was granted under (§10). delivery_status reports an older one as none. */
  authority_epoch: number;
  /** delivery_status only, never stored: why a web-verified receipt reads as none now (§10). */
  downgraded?: "disabled" | "revoked" | "loopback_only" | "named_link_off";
}
```

How each delivery is labelled:
- **Platform messages and clicks:** `kind: "platform"`, with the actor from `HumanOrigin`.
- **Web messages, clicks, `/steer` and `/btw`:** `kind: "web-verified"` when §3 holds for that request and its session
  is authorized (§0); otherwise `"none"`.
- **S1's observe-only `web-session`** (#2108) is read as `"none"`: it was never an authorization.
- **No `step_up` field** is written (§0).
- `HumanOrigin.platform` stays `"web"` for web traffic, so a web-verified receipt can never be confused with a
  platform one.

**What `delivery_status` returns.**
- The receipt returns `authority` next to `origin` and `proof_kind`.
- `source_instance` becomes `human:web:<adapter_id>:<user_id>` for a web-verified receipt, so the coordinator's logs
  name the person.
- For a `none` receipt it stays `human:web:unknown`.

**What the agent sees.** The inbound header stays a recognition label. A web-verified message reads
`[user:<name> via web (verified), id:<platform id>]`. "(verified)" is a hint only: agents must still read the
receipt, because header text can be faked by anything that reaches the pane.

**Rows written before this change** have no `authority`.
- A row without it, from Discord or Telegram, means `platform`.
- A row without it, from web, means `none`.

So nothing an agent accepted before changes meaning.

## 5. The step-up list: a class, a configurable enforced list, one source

> Superseded by §0 (2026-10-18): there is no per-action step-up and no enforced list.


**The class.** A step-up is for actions that are irreversible, outward-facing, or touch accounts and credentials.
The instructions and the docs name three examples (release, force-push, deleting an instance) and describe the class.
They do not enumerate every action.

**Agents judge by context.** For an action in the class that is not on the enforced list, an agent decides from
context whether ordinary web authority is enough. When unsure, it asks the person for a step-up, or for confirmation
on Discord or Telegram.

**The enforced list is the user's.** Settings → Web sign-ins → "Always require a step-up for" lets the user add or
remove actions. AgEnD enforces whatever is on it, and only that.
- **The default** is `release`, `force-push` and `delete-instance`.
- **Adding** an action takes effect at once.
- **Removing** one goes through Settings confirmation, because that loosens the rule.
- **Custom actions.** The user can define actions the catalog doesn't name. Each has its own id and label, with target
  kind `text`.

**The configuration** (fleet.yaml, the only place the list and custom definitions live):

```yaml
web:
  verified_authority:
    enabled: false              # the server switch (§10)
    loopback_only: false        # "Only this computer can authorize" (§3.4)
    max_session_hours: 48       # 1–48 (§3.6)
    step_up:
      enforce: [release, force-push, delete-instance]   # catalog ids and/or custom ids
      custom:                                            # user-defined actions, merged with the catalog
        - { id: drop-database, label: "Drop a production database", label_zh: "刪除正式資料庫" }
```

- **How the two lists combine.** `step-up-policy.ts` merges the catalog and `custom` into one action table. A custom
  id must match `^[a-z][a-z0-9-]{2,31}$` and must not shadow a catalog id; the config validator refuses one that does.
  `enforce` may name only ids in the merged table. A custom action's target kind is always `text`.
- **A binding is self-describing.** It records the action's id **and** its label as shown when it was issued
  (`binding.action_label`). If a custom definition is later deleted or relabelled, receipts already written still
  read correctly. An id that is no longer in the table is simply not enforced. A step-up for it remains valid
  evidence until its `act_by`.

**One source.** `src/authority/step-up-policy.ts` holds:
- **The catalog.** The schema and the actions people can pick from. Each entry has an id, English and zh-TW labels,
  and the target kind it names.
- **The default list.**
- **One reader,** `enforcedStepUps(config)`, which every consumer goes through:
  - the receipt writer, which validates `step_up.binding.action` against catalog ids or the configured custom ids;
  - the instructions builder, which renders the three examples, the class, and the *current* enforced list from
    config;
  - the `/authorize` page, which builds its menu from the catalog plus the configured custom actions;
  - `delivery_status`, which returns the list in force as `step_up_policy: { version, enforced: [ids] }` with every
    human receipt. `version` is informational: it changes when the list changes, and it is **not** the revocation
    epoch. Agents never have to guess the list.
- **A docs test** pins the three examples and the defaults against `docs/features.md`.

| id (catalog) | What | Target | Enforced by default |
|---|---|---|---|
| `release` | publish a package, push a release tag, create a GitHub release | tag | yes |
| `force-push` | force-push or delete a remote branch | branch | yes |
| `delete-instance` | `delete_instance`, `replace_instance`, `teardown_deployment` | instance | yes |
| `merge` | merge into a protected branch (main, release/*, feature integration branches) | pr | — |
| `history-rewrite` | rebase, reset or amend anything already pushed and shared | branch | — |
| `real-account` | requests on a real vendor account or host login (probes, audits) | account | — |
| `deploy` | deploy to a shared or production environment | text | — |
| `close` | close or lock an issue or PR that someone else opened | pr or issue | — |
| `credential` | switch an instance to another account or credential profile, `/login` for someone else | instance | — |
| `fleet-control` | stop, restart or update the whole fleet | text | — |

There is no separate `grant` action. Who may *perform* the action is part of every step-up (`executors`, §6.1).

**Changing the list never revokes anything.** It changes only which actions need a step-up. The receiver applies the
list `delivery_status` returns *now* to the receipt it is about to act on. Revocation is separate (`authority_epoch`,
§10). Examples, with a release step-up issued at 10:00 that can be acted on until 10:15:
- **At 10:01, force-push is removed.** The release step-up still passes, because release is still enforced and the
  step-up matches. An ordinary web-session message from 09:55 asking for a force-push now needs only ordinary
  authority, plus the agent's judgement.
- **At 10:01, merge is added.** That same 09:55 ordinary message, if it asked for a merge, no longer suffices: merge
  is enforced now, and the message has no step-up for it. Unrelated receipts and existing step-ups are unaffected.
- **Release is removed.** The 10:00 release step-up is still valid evidence. Release just doesn't require one any
  more.

**The coordinator.** The coordinator's human-consent rule uses the same configured list.
- **`merge` is off by default.** A human go-ahead to merge is then judged by context, while `gate-merge.sh` still
  enforces the mechanical reviewer gate.
- **If the user enforces `merge`,** the coordinator's instructions require platform authority or a matching web
  step-up for it.
- **A mechanical check is a follow-up.** Making `gate-merge.sh` itself read the list is a separate decision.

**Not on the list,** because each already has its own gate:
- Settings writes (Settings confirmation);
- mod and effect installs (local admin plus plan hash);
- owner CSS (admin tier);
- `/raw` (fleet admin, and it never has a positive receipt).

A step-up never replaces those gates. It is about authority that an agent acts on.

**The rule receivers apply.** For an action on the **enforced list in force now** (`step_up_policy.enforced`), accept a
human authorization only if one of these holds.

**Platform authority.** `authority.kind` is `platform`, and the content names the action and target (today's rule).

**A web step-up.** `authority.kind` is `web-session`, and every one of these holds:
1. **The hash.** `sha256(JCS(step_up.binding))` equals `step_up.binding_sha256`.
2. **The content.** `binding.content_sha256` equals the receipt's own `content_sha256` (the original text).
3. **Actor and session.** `binding.actor` equals `authority.actor`, and `binding.session_handle` equals
   `authority.session.handle`.
4. **Action and target.** `binding.action` is the action about to be performed, and `binding.target` is exactly the
   resource it will be performed on (same repo, same number, same SHA).
5. **Executor.** The receiver itself is in `binding.executors`.
6. **Not expired.** The current time is before `binding.act_by`. A receipt whose `verified_at` is not before
   `binding.redeem_by` is invalid, and AgEnD never writes one.

For anything else, accept `platform` or `web-session`, never `none`.

**In the class but not enforced.** For an action in the class that the list doesn't enforce, `web-session` may be
enough. The agent judges by context and asks for a step-up when unsure.

The receiver applies the rule to the receipt **as `delivery_status` returns it now**. A downgrade by the server switch
(§10) therefore takes effect on the next check.

## 6. The step-up mechanism

> Superseded by §0 and §0.1 (2026-10-18): the Confirm card authorizes a session, not one action. There is no DM code
> and no separate `/authorize` document, so §6.5's rules no longer apply.


### 6.1 What a step-up is bound to

```ts
interface StepUpBinding {
  v: 1;
  challenge_id: string;          // 32 hex, the code's or the card's id
  action: string;                // an id in the merged action table (§5)
  action_label: string;          // its label as shown at issuance, so the receipt reads correctly later
  target: StepUpTarget;
  content_sha256: string;        // the exact original text of the web message being authorized
  audience: string;              // the instance the message is delivered to
  executors: string[];           // who may perform the action: [audience] by default (§6.4)
  session_handle: string;
  actor: { adapter_id: string; user_id: string };
  issued_at: string;             // when the challenge was issued (ISO 8601, UTC, ms)
  redeem_by: string;             // issued_at + 5 min: the code or click must be redeemed before this
  act_by: string;                // issued_at + 15 min: no executor may act on it at or after this
}
binding_sha256 = sha256(JCS(binding))   // RFC 8785 canonical JSON
```

AgEnD builds the binding **before** it issues the challenge. Every field, including both deadlines, is known at
issuance. The DM or the card shows its human-readable parts ("act by 10:15"), and the code or click confirms exactly
that binding.
- **Time is fixed at issuance.** Redemption only stamps the separate, server-owned `step_up.verified_at`. It never
  changes the binding, so a challenge issued at 10:00 and redeemed at 10:04 can still be acted on until 10:15.
- **Stored whole.** On verification, the binding is stored unchanged in the receipt, so receivers need nothing that
  isn't in the receipt to check it (§5).
- **Text changes.** Editing a single character of the text means a new challenge.
- **Scope.** The step-up is part of that one message's receipt. It is not a session-wide permission.

**What "single use" means.**
- **Single-use part:** the *challenge*. A code or a click is redeemed at most once.
- **Not single-use:** the *receipt*. It is immutable evidence, and reading or forwarding it doesn't consume
  anything.
- **Acting twice:** whether an executor may act twice is the action's own business. The target pins the exact
  resource, so a second merge of the same PR is a no-op, and a release names its exact tag.
- **The mechanical gate:** `gate-merge.sh` may additionally record the binding ids it has used. That is optional, and
  is noted as a follow-up.

### 6.2 Kind A: a DM code

1. In the composer, the person picks **Authorize…**. This opens AgEnD's own Authorize page (§6.5). It asks for:
   - the action, from §5;
   - the target. For SHA, PR and branch targets AgEnD checks the target exists (`git cat-file`, `gh pr view`) and
     shows the resolved value, e.g. the full 40-character SHA.
   - the message itself.
2. AgEnD issues a code with the sign-in code machinery: 8 characters base32, single use, 5 minutes, 5 tries, one
   outstanding code per session. It sends the code with `sendDirect` to the session's owner, **only** that account,
   and never falls back to a channel. The DM shows the action, the target value and the first 200 characters of the
   message, and says:
   - "Enter this only on AgEnD's own Authorize page (check the address bar: <host>/authorize). AgEnD never asks for it in chat or in a page an agent sent."
   - "If you didn't ask for this, revoke your web sessions with /web revoke."
3. The person types the code into the Authorize page. `POST /authorize/verify` is cookie-authenticated,
   same-origin, requires the CSRF header, and re-evaluates every §3 condition on that request.
   - On success the message is sent through the normal `/ui/send` path, with `authority.step_up` filled in.
   - Wrong, expired, spent and none-issued codes all get the same answer, and failures count toward the existing
     breaker.

**What a DM code proves, and what it doesn't.**
- **What it shows.** Whoever redeemed it saw a message sent to that account in the last 5 minutes, and redeemed it
  in the bound session, for the bound action.
- **It is phishable.** Someone who controls the qualifying session (a stolen browser on this machine is in the
  threat model) and gets the person to reveal the code can redeem it. A page an agent sent can ask for it: the
  preview origin can't read the cookie or call `/authorize/verify`, but what a person types into a page can leave it
  (`1306-inline-html-preview.md` §4.3 keeps navigation and proxy-log exfiltration as known limits).
- **The platform click is stronger.** It is the person's own platform client, showing the action and target in the
  platform's UI. Both kinds ship (the user's decision); the Authorize page offers the click first.

### 6.3 Kind B: a platform click

Instead of a code, the dialog can post a Confirm/Reject card.
- **Where.** In the owner's DM. If DMs fail, it goes in the General of the owner's adapter. It never falls back to
  another adapter's General or to the host CLI: only the bound account can satisfy it. The card shows the binding's
  action, target, executors and the first 200 characters of the text.
- **Who.** Only the bound account can claim the click: its `user_id` must equal the session's owner. Any other admin
  gets "not yours".
- **Shape.** It reuses the settings-confirmation shape: a 5-minute TTL, a nonce, a single decision.
- **Receipt.** The click is itself a platform action receipt (`ingress: "action"`, with `event_id` set). The web
  message's `step_up` records `kind: "platform-click"` and that `event_id`, so a receiver can check the click too.

`MessageBus.requestApproval` already exists with no callers. It is the natural primitive if its buttons are bound
to `binding_sha256`.

### 6.4 When an agent asks for one

**Not in S2** (the user's decision). In S2 a step-up is always started by the person on `/authorize`; an agent that
needs one says so in its reply. The card below is a later stage (S4), recorded here so its constraints are not lost.

An agent cannot open the Authorize page and cannot write a step-up. It may only *suggest* one, with a new MCP tool:

```
request_step_up({ action, target, summary })
```

The tool posts a host-rendered card into the web chat, marked `data-trust="thread-control"` like other host cards.
- **The card.** It shows "<agent> asks you to authorize <action> on <target>", with one button, **Authorize…**. The
  button opens the `/authorize` page prefilled. The person still sees and confirms everything, and the code or click
  still comes from their own account.
- **Not a reply button.** An ordinary agent reply button can never start a step-up.

**Audience, executors and forwarding.**
- **Audience.** The instance the web message is delivered to.
- **Executors.** The instances the person allows to *perform* the action. The default is the audience alone. The
  Authorize page lets the person add others, typically "and the coordinator" for a merge or release that the
  coordinator performs. The list is part of the binding and is shown in the DM or on the card.
- **What `forwards` does.** It only lets another instance *read* the receipt, as today. It never makes the reader an
  executor: a receiver acts only if it is in `binding.executors` (§5, check 5).
- **Changing executors.** To let a different instance perform the action later, the person issues a new step-up
  that names it. There is no relay that widens the executors.

### 6.5 The web UX

- **A separate document.** Authorization does **not** happen inside the app page. Owner CSS (`owner-css.js`) is a
  whole-document stylesheet installed last in `<head>`, and `effect-stock-trust` only decides where *effects* may
  paint: it does not exclude CSS selectors. A `data-trust` marker therefore cannot protect controls from CSS.

  So the flow runs on its own top-level page, `/authorize`, opened in a new tab or window. That page:
  - links only its own fixed stylesheet (`authorize.css`, `style-src 'self'`). It never links owner CSS or app.css
    and loads no mod, theme, widget or effect module;
  - sends `frame-ancestors 'none'` and must be a top-level browsing context;
  - shows agent-supplied text (the summary, the message excerpt) only as text nodes;
  - is the only place a step-up is started or verified.

  The person can confirm where they are from the browser's address bar.
- **The in-app entry is just a link.** The composer's **Authorize…** opens `/authorize?…`. Owner CSS can hide or
  mislabel it.
- **App controls can be disguised.** CSS can restyle the composer and its Send button as a fake "enter your code"
  prompt. A code typed there becomes chat text the agent receives, which is the code phishing §6.2 already admits.
  The only trustworthy places are `/authorize`, confirmed in the address bar, and the platform's own Confirm card.
- **In-app indicators are informational.** An "Authorized: merge #2001" line under a bubble can be faked with CSS
  `content:` on the app page, so nothing relies on it. The trusted views are:
  - the `/authorize` page's history;
  - the receipt that receivers read;
  - the DM notice of §7.
- **States** (on `/authorize`): **Choose → Waiting for code / Waiting for click (4:59) → Verified, sent → Expired /
  Failed**. It shows the bound account ("Your Discord: <name>").
- **Tests required before S3** (negative ones):
  - `/authorize` links no owner CSS, mod, theme or effect resource, and has none applied, even when owner CSS is
    active on the app;
  - it refuses to be framed;
  - agent text appears there only as text;
  - an app-page owner CSS that styles `.authorize-*` or `[data-trust]` has no effect on `/authorize`.

  CSS isolation (a separate document) and effect paint suppression (barriers) are two different mechanisms. Both
  are needed, and neither stands in for the other.
- **Escape hatch.** "Use Discord instead" on `/authorize` ends the challenge and says what to type there.
- **Phones.** `/authorize` is a responsive top-level page. It is never an in-app sheet or dialog.
- **Public link.** Authorize is not offered there, and the composer says why.

## 7. Audit

New `EventLog` event types (§0):
- `web_authority`: each web-verified message;
- `session_authorization_issued`, `session_authorization_verified`, `session_authorization_failed`,
  `session_authorization_expired`: the Confirm card and code that authorize a session.

Every event carries:
- the receipt id (for a message) or the challenge id (for an authorization);
- the session handle (never the id or its hash);
- `peer` (loopback, lan or named_link, §0.2), plus `surface`, and the hostname for `named_link`;
- the actor `adapter_id:user_id`;
- the outcome and its reason.

No code, cookie, CSRF value or message text is logged; the receipt keeps the text.
- **Retention.** Events follow the event log's retention, not the receipt pruning, so the trail outlives the
  receipt.
- **Notice.** Each `session_authorization_verified` also sends a one-line DM to the owner: "You authorized a web
  session (<device>) at <time>; it speaks as you until <time>". It is the cheapest way to notice theft: a notice for
  something you didn't do means you should revoke.
- **Where it shows.** Settings → Web → Web authority lists the authorized sessions and the last 50 authority events.

## 8. Threats

> Read under §0: where a row says "step up", it means "authorize the session". A browser whose session is already
> authorized speaks as the account until the authorization runs out (`max_session_hours`) or is revoked. Authorizing a
> new session still needs the account's own click, or a code the person reveals.

| Threat | Today | With this design |
|---|---|---|
| A stolen or unlocked browser on this machine | It can chat; it authorizes nothing | It can give ordinary authority for up to 48 h (the default age). It can step up only with the account's click, or a DM code the person reveals (codes are phishable, §6.2). Revocation: `/web revoke`, the device list, `agend web-token rotate`, or the server switch (§10) |
| A stolen cookie used from another machine on the same network (LAN, tailnet) | It can chat | **Accepted risk by default** (the user's decision, 2026-10-17): it can give ordinary authority, and step-ups only with the account's click or a revealed code. Turning on "Only this computer can authorize" (§3.4) stops it for new messages, and makes existing `lan` receipts and step-ups read as `none` (§10). The receipt and the audit log record `peer: lan` |
| A stolen cookie used from outside the network | It can chat | **A deployment assumption, not an AgEnD barrier.** If the health listener is reachable only through the public link, outside requests arrive on the `gateway` surface, which never qualifies (§3.5). If the listener itself is exposed (a port forward, a changed bind, an ordinary reverse proxy), the classifier sees only "not loopback", calls it `lan`, and by default it qualifies. Turn on "Only this computer can authorize", or don't expose the health listener |
| Public link, quick tunnel | Recognition only | Never authority (§3.5) |
| Public link, the admin's named tunnel, option off (the default) | Recognition only | Never authority: `named_link_off` (§0.2) |
| A cookie stolen from a browser that used the named link, option on | It can chat | It can be replayed from anywhere on the internet. A session not yet authorized still needs the account's Confirm (the card says "over your named link <hostname>"). An authorized one speaks as the person until the earliest of: the 30-min idle limit, the 4 h absolute limit, `max_session_hours`, Not me, `/web revoke` or the option off. Turning the option off downgrades its receipts at once (`named_link_off`). **The risk the admin accepts by turning the option on** (§0.2) |
| Cloudflare, which terminates TLS for the named link | It sees the traffic and the cookies | Unchanged, but those cookies can now carry authority while the option is on: the trust already placed in the admin's Cloudflare account extends to it. Cloudflare Access or mTLS in front of the hostname is compatible and out of scope (§0.2) |
| A stolen web session turning the named-link option on | — | Turning it on needs a fresh confirmation from an eligible General or the host CLI (§0.2). It is never self-confirmed (#2170), even by an already web-verified local session or when mixed with other keys, and it can't be changed over the public link |
| A named-link session confirming held Settings changes itself (#2170) | — | Never: self-confirmation needs a request off the public link and a session whose peer isn't `named_link` (§0.2) |
| A reverse proxy in front of the health listener (forwarding headers or not) | Same as local | Classified `lan`, with or without forwarding headers (a header-stripping local proxy reads as loopback; see the next row). It qualifies by default, which is right only if everyone who can reach that proxy is trusted (the previous row). Under "Only this computer can authorize" it doesn't qualify, except for the case in the next row (a local proxy that strips forwarding headers), which can't be told apart from a local browser and is out of scope |
| A local reverse proxy that strips forwarding headers | Same as local | Not supported for authority. Indistinguishable from a local browser, so out of scope like other local processes (§3.4) |
| An agent asks the person to "just click" | Same on any platform | A reply button can never step up. A step-up needs the `/authorize` page plus the person's own click or DM code, and shows the exact action, target and executors |
| A phishing page in an agent's HTML preview asks for the code | — | The page can't use the code itself (no cookie, no `/authorize/verify`), but the code can leave it, and whoever holds the session can redeem it. The DM says where to enter it. Both kinds ship; the Authorize page offers the click first |
| Script in the dashboard origin | CSP and the preview origin keep agent HTML out | Unchanged, and now load-bearing. The §9 invariants become release blockers |
| Owner CSS, or imported CSS, restyles or fakes authorization UI | — | Authorization happens only on `/authorize`, a separate document with no owner CSS, mods or effects (§6.5). In-app indicators and app controls can be disguised by CSS (e.g. as a fake code prompt, which is the phishing in §6.2). Only `/authorize`, confirmed in the address bar, and the platform's Confirm card are trusted |
| Replaying a step-up on another message, target or executor | — | The receiver recomputes `binding_sha256` and checks content, target, executors and expiry (§5). The challenge is single use |
| Turning web authority off in a hurry | — | The server switch downgrades every web-verified receipt on the next `delivery_status`, whatever instructions an agent runs with (§10) |
| An old fleet with old instructions | Rejects web | Still rejects web, so the safe default holds. Receivers act on web authority only after the instruction change (§10, S3) |
| Header text forging "(verified)" | — | Instructions say to read the receipt, never the header |

## 9. 2.3 mods and effects: what must stay true

Web authority makes "no script runs in the dashboard origin" a security property, not just a design preference.
These must hold, and a change to any of them needs a security review and a fresh look at this design:

1. **Script.** The dashboard CSP stays `script-src 'self'` with fixed host assets only. There is no `unsafe-eval`, no
   remote script and no mod-supplied script. Panel nonces are host-issued per response.
2. **Mods never carry script or HTML.** An agent-proposed mod carries no CSS either. A human-imported bundle
   (`web-mod-bundle.ts` `contents.ownerCss`) may carry owner CSS, which `web-mod-store.ts` applies as owner CSS.
   So imported CSS falls under invariant 3.
3. **Owner CSS** (typed or imported) is re-serialized from tokens: no `@import`, and no `url()` other than `asset:`.
   It may restyle any app page. Authorization therefore lives on `/authorize`, a document owner CSS is never linked
   into (§6.5). It is **not** kept out of reach by `effect-stock-trust`, which governs effect paint, not CSS.
4. **Effects** run only in the sandboxed opaque-origin frame or worker (`sandbox="allow-scripts"`, no same-origin)
   on the preview listener. A trial is local-admin-only and never public (1629-effect-trial-authority).
5. **Agent HTML previews** stay on the preview origin, with `connect-src 'none'` and no cookies.
6. **`/authorize` stays bare.** It loads no mod, theme, widget, effect or owner-CSS resource, can't be framed, and
   shows agent text only as text. Adding any of those to it needs this design reopened.

## 10. Migration and staging

> Amended by §0 and §0.1 (2026-10-18): the revocation rules below stand; S2–S4 are replaced by §0's staging. The switch is
> on by default, and turning it on (or loosening `loopback_only` or the hours) applies at once, with no Settings
> confirmation (§0.1).


- **The switch, first.** `web.verified_authority.enabled` is a server setting, off by default, and turning it on
  goes through Settings confirmation. Each authority is stamped with the current `authority_epoch`.
- **What revokes, and only what revokes.** `delivery_status` evaluates every web-verified receipt against the
  revocation state *now*:
  - **Turning the switch off.** The change from `enabled: true` to `false` atomically bumps `authority_epoch`, in
    the same write. While the switch is off:
    - every web-verified receipt reads as `kind: "none"`, whatever its epoch, step-ups included, with
      `downgraded: "disabled"`;
    - new web receipts are written as `none`.
  - **Bumping `authority_epoch` without turning off.** `/web revoke` does this, and so does a Settings "Revoke web
    authority". From then on, every web-verified receipt from an older epoch, step-ups included, reads as `none` with
    `downgraded: "revoked"`.
  - **Turning it back on.** It goes through Settings confirmation. Only authority granted *after* that, under the
    current (already bumped) epoch, counts. A receipt from before the switch was turned off can never come back,
    whether it was ordinary or a step-up still before its `act_by`: its epoch is older than the current one, so it
    stays `none`.
  - **Turning "Only this computer can authorize" on.** From then on, every web-verified receipt whose
    `session.peer` is `lan` reads as `none` with `downgraded: "loopback_only"`, step-ups included. `loopback`
    receipts are unaffected. Turning it off again doesn't restore them: re-enabling requires Settings confirmation,
    and the epoch is bumped along with it.
  - **Not revocation.** Changing the enforced step-up list or its `version` (§5), lowering `max_session_hours`, or
    editing custom actions. These affect only what is required or allowed from then on, as §5 describes.
  - **Why this is fail-closed.** It doesn't depend on which instruction text an agent is running: agents act on the
    receipt they read now (§5).
- **The named-link option (§0.2).** Turning `web.verified_authority.named_link` off makes every `named_link` receipt
  read as `none` with `downgraded: "named_link_off"`. Turning it back on is confirmed and bumps the revocation epoch,
  so those receipts never come back. `loopback_only` on downgrades `named_link` receipts as it does `lan` ones. Close,
  the link's expiry and fleet stop end the sessions (their next messages carry `none`) and delete their
  authorizations; receipts already written stay evidence, as for any ended session (§0, item 3).
- **S1: observe only.** Admission evaluates §3 per request, computes `authority`, and writes it into receipts, and
  `delivery_status` returns it. Instruction text is unchanged, so agents keep refusing web. Ship this first and watch the `web_authority`
  events for a beta cycle.
- **S2: step-up, person-initiated only.** Add `step-up-policy.ts` and the Settings list, the `/authorize` page, the server switch, DM codes, platform clicks and
  the audit events. Instructions are still unchanged.
- **S3: instructions.** Only S3 changes what agents accept. Every place in §2 that says web carries no permission is
  rewritten from one generated paragraph:
  - **`VERIFY_PEER_MESSAGE_RULE`.** It keeps the platform rule and adds: "A web receipt counts only with
    `authority.kind: web-session`. For an action on the enforced list (`step_up_policy.enforced`, rendered from config), require
    `authority.kind: platform`, or `web-session` with a `step_up` that passes every check in §5: the recomputed
    `binding_sha256`, the content, the actor and session, the action and target, you among the executors, and not
    expired. `none` never counts. Other actions that are irreversible, outward-facing, or touch accounts and
    credentials (for example a release, a force-push, deleting an instance) need judgement: if you are unsure that
    ordinary web authority is enough, ask for a step-up or for confirmation on Discord or Telegram."
  - **The MCP Message Format line.** "`via web (verified)` is a hint; read the receipt's `authority` before acting.
    Plain `via web` grants nothing."
  - **The rest.** `agent-whats-new.ts` gets a new entry. `agent-cli-instructions.md` and the two skills
    (`cross-instance-messaging`, `worker-collaboration`) get the same paragraph.
  - **The coordinator's instructions.** "A human go-ahead for an action on the enforced list in force needs
    platform authority or a matching web step-up. A reviewer instance's APPROVE is not human consent."
  - **Live instances.** They see the new text on their next session, through the existing "Instructions changed"
    path. A running agent may keep the old or the new text until then.
- **S4 (later): the agent card.** `request_step_up` and its host-rendered card (§6.4), once S2 and S3 have run in a
  beta.
- **Rollback.**
  - **Immediate stop:** turn the switch off (or bump `authority_epoch`). Every web-verified authority, including
    already-verified step-ups, reads as `none` from the next `delivery_status`, so even an agent still running S3
    text gets nothing to act on.
  - **Code and instructions:** after that, revert S3 (and S2/S1 if wanted). Live instances pick up the reverted text
    on their next session; a restart of the fleet's instances makes that immediate.
  - **What is not promised:** a file revert alone does not revoke anything immediately. The switch is what does.

## 11. Decisions (the user, 2026-10-17)

> Decisions 4–6 and the open executor question are superseded by §0 (2026-10-18); 1–3 stand.


1. **Field.** A new `authority` field (§4), not a new `proof_kind`.
2. **Ordinary authority age.** 48 h by default, configurable from 1 to 48 h (§3.6).
3. **LAN and tailnet.** They qualify by default. Settings can restrict to this computer, and the risk is accepted
   (§3.4, §8).
4. **Step-up kinds.** Both the platform click and the DM code (§6.2, §6.3).
5. **The list.** The docs and instructions describe the class with three examples, and agents judge by context. The
   enforced list is the user's, configurable in Settings, defaulting to release, force-push and delete-instance.
   One source file holds the schema and the defaults, and the receipts and the coordinator use the configured list
   (§5).
6. **The agent card.** Later (S4), not S2. S2 is only the person-initiated Authorize flow (§6.4).

Still open, for the implementation PR: whether the Authorize page offers "and the coordinator" as a one-click
executor, or only explicit instance names.

## 12. Not in scope

- Read-only web sessions (D6).
- Hardware keys or passkeys. A natural later step-up kind, with the same `step_up` shape.
- Code-level enforcement of merges or releases, which remain instruction-level, as today.
- Any change to platform authority.
