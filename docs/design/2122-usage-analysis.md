# #2122 Usage analysis per agent

Status: design approved by the leader (2026-10-18). This revision adds the data contracts the review asked for (§5)
and the tokscale reference (§2.1).

**Target:**
- **2.3:** the measured backends, Claude Code and Codex. The others show as "not measured", each with its reason.
- **2.4:** readers for Kiro and OpenCode. Grok, Muse and Antigravity follow once their formats are verified (§2.1).

## 1. What the user asked for

The user's Discord request (hmsg-6bf9f0f1, relayed by the leader) wants tokscale-style usage analysis in the web
dashboard. The screenshot was another fleet's page, so there is no code of theirs to reuse. It showed:
- range tabs: today, 7 days, this month, all;
- "updated at … (cached ~2.5 min)";
- ranked rows per agent: a cost and a proportional bar; input, output, cache read, cache write and total tokens; and a
  message count.

Its top row reads "cache read 0, write 0" and costs the most. That is the trap this design avoids: cache that isn't
reported must never look uncached and expensive.

## 2. Data: what AgEnD can measure today

Almost everything already exists in the prompt-cache report's ledger (#1468, #2010, #2030).
- **What it does:** `CacheService` scans transcripts incrementally, in the background, with a 16 MB budget per pass,
  and attributes each transcript to an instance.
- **What it keeps:** hourly totals per **model and price tier** (the `model|long-tier` key) for 31 days, in
  `~/.agend/instances/<name>/cache-ledger.json`. Each total is `[requests, uncached, read, write5m, write1h, write,
  output]`.

| Backend | Source | Input | Output | Cache read | Cache write | Model | Status in 2.3 |
|---|---|---|---|---|---|---|---|
| claude-code | `<config dir>/projects/<key(cwd)>/*.jsonl` (the credential profile's dir) | ✓ | ✓ | ✓ | ✓, 5m / 1h split | ✓ | **measured**, without subagent or sidechain files (noted on the page) |
| codex | `$CODEX_HOME/sessions` rollouts, by `session_meta` cwd | ✓ | ✓ | ✓ (`cached_input_tokens`) | recorded as **0** by every CLI seen so far | ✓ | **measured; cache write "not reported"**, never priced as uncached |
| kiro-cli | `conversations_v2.history[].request_metadata` | ? | ? | ? | ? | ✓ | **not measured**: every field is null in the only fixture, and Kiro bills in credits. 2.4. |
| opencode | `opencode.db` `message` / `session_message` rows (§2.1) | (✓) | (✓) | (✓) | (✓) | (✓) | **not measured** in 2.3; a 2.4 reader on tokscale's schema |
| grok | `~/.grok/sessions/*/*/updates.jsonl` (§2.1) | (✓) | (✓) | (✓) | (✓) | (✓) | **not measured** in 2.3; to verify offline, then 2.4 |
| muse | `session.jsonl` `model_completed` usage (§2.1) | (✓) | (✓) | (✓) | (✓) | (✓) | **not measured** in 2.3; to verify offline, then 2.4 |
| antigravity | `~/.gemini/antigravity-cli/conversations/*.db` (a protobuf in SQLite, §2.1) | (✓) | (✓) | (✓) | — | (✓) | **not measured**; it needs a protobuf decoder. Later. |

(✓) means tokscale reads the field; AgEnD hasn't verified it on this host yet.

- **A request** is one model call: an assistant turn or a tool-loop step, as the transcript records it. The ledger
  counts these today.
- **A message** is a human message **delivered** to the instance. It is counted once, on its receipt's first
  transition to `delivered` (§5.4), so failed or uncertain handoffs don't count. It is measured for every backend.
- **Which instances:** fleet.yaml instances plus ClassicBot rooms (`cacheInstances()`). Instances that share a working
  directory are `shared` and not split, as in the cache report. They show as "shared with …", never as zero.

### 2.1 tokscale as the reference

tokscale (github.com/junhoyeo/tokscale, MIT License, "Copyright (c) 2025 Junho Yeo"; the repo's `LICENSE` was read
2026-10-18 at commit `e2039b141411a72e2d5ed5e813512d7125947cbc`) parses about 55 clients into one `UnifiedMessage` with `TokenBreakdown {input, output,
cache_read, cache_write, cache_write_1h, reasoning}`. It was read only, never run.

**What we take from it** (as knowledge; no code is adapted in 2.3):
- **Claude:**
  - dedup by `message.id:requestId`;
  - a streamed duplicate merges by the larger value per field, and the copy that reports the cache split wins for input;
  - `<synthetic>` rows are skipped.
  - AgEnD's ledger dedups by message id today, and gains the merge rule.
- **Codex:**
  - reasoning is part of output, so it is never added twice;
  - cached tokens are capped at input;
  - a fork or subagent replaying the same history is deduped on its cumulative totals;
  - cache writes are always 0, as we found.
- **Pricing:** 5m and 1h cache writes are priced separately, each against its own long-context boundary. A per-request
  tier rule (272k, 200k, 100k) is applied per request, not to aggregates. AgEnD's ledger already keeps the tier per
  request.
- **Days:** bucketed in one timezone recorded for the data. Rescanning in another zone split days differently and
  inflated totals in tokscale. That is the reason for §5.3.
- **The label:** "API-equivalent estimates, not subscription charges", the same stance as ours.
- **The heatmap:** intensity 0–4 by a day's share of the highest day (cut points 0.75 / 0.5 / 0.25 / > 0).
- **For 2.4:** the session formats and field names for OpenCode (its SQL and fingerprint dedup), Grok, Muse, and Kiro.
  tokscale *estimates* Kiro from byte sizes because real counts are often 0. AgEnD would show such numbers as an
  estimate, or not at all.

**Where AgEnD differs:**
- **Attribution:** usage is attributed to an **instance** (working directory, credential profile's config dir, codex
  cwd, ClassicBot rooms), not to a device's whole history.
- **Profiles:** credential profiles and the subscription they belong to are part of each row (§5.1).
- **Prices:** a **bundled, checked** price table (`cache-prices.ts` with its date), never fetched at run time.
  tokscale fetches LiteLLM, OpenRouter and models.dev every hour. A handler never reaches the network, and a missing
  price is "not priced", never fuzzy-matched.
- **Messages:** counted from AgEnD's own delivery receipts, not from transcripts.
- **Backends tokscale doesn't cover:** none of our seven is missing from it. Its Kiro numbers are estimates, so a Kiro
  row is "not measured" until real `request_metadata` is shown to carry tokens.
- **No CSV in tokscale** (it exports JSON). We add CSV.

**If code is adapted later** (2.4 readers): each adapted file gets a header comment naming tokscale, its MIT licence and
the commit. The repo gets a `THIRD_PARTY_NOTICES.md` entry carrying tokscale's copyright and licence text. tokscale is
never a runtime dependency and is never shelled out to.

## 3. Cost: list-price equivalent, never "spent"

- **Prices:** `src/cache-prices.ts` (`TABLE`, `PRICES_CHECKED`, `PRICE_SOURCES`), the table the cache report uses. It
  holds standard-tier list prices per million tokens. Claude cache writes are priced at 1.25× input (5m) and 2× input
  (1h). The long-prompt rows are applied per request, through the tier kept in the ledger key. The table is updated in
  code with its "checked" date.
- **The label:** every amount, on the page, in the CSV and in the agent tool's output, carries **"API-equivalent at
  list price (checked <date>) — not money spent"**.
  - **On the page:** a subscription is not billed per token, so the page never says "spent" or "cost". The ◔
    subscription plans are shown beside the amounts as context, never summed into them.
  - **In `get_usage_report`:** the same words go in each amount's `basis` field and in the summary. Its description
    tells the agent to say "API-equivalent", never "spent", so General answers that way.
- **Honest gaps:**
  - **Unpriced model:** its tokens show, its cost says "not priced", and the instance's sum is marked "partial".
  - **Codex cache writes:** "not reported", never 0. They are left out of the cost, which is marked as an estimate.
  - **Not measured:** no amount, only the reason. It is never a $0 row ranked last.

## 4. Views

The page is **Fleet → Usage** (`/ui/fleet/usage`), next to Cache. There is no usage page today; the ◔ dialog of
subscription quotas gains a "By agent →" link.

- **Ranges:** today, 7 days, this month, all (everything collected, §5.5), and a custom from–to. Days are in the
  fleet's timezone (`scheduler.default_timezone`, else the host's) at hour granularity (§5.3).
- **Rows:** per instance by default, ranked by amount (by tokens where unpriced). Each row has:
  - a proportional bar;
  - input, output, cache read and cache write, and total tokens;
  - requests and messages;
  - its backend, model(s) and credential profile.
  "Not measured" and "shared" instances are listed below the ranked rows with their reason.
- **Group by:**
  - instance (the default);
  - backend;
  - model;
  - credential profile, as recorded when the usage was measured (§5.1);
  - team, by **current** membership and labelled so ("teams as configured now").

  Grouping by person isn't offered: tokens can't be attributed to whoever wrote a message.
- **Trend:** a stacked daily bar chart (amount, or tokens when unpriced) of the top 5 instances and "others". Below it,
  a calendar heatmap of daily totals over what was collected, with tokscale's intensity buckets. Both follow the
  `dataviz` skill: an accessible categorical palette as tokens for light and dark, and text labels and `aria`
  descriptions, so colour is never the only cue.
- **Export:** CSV of the daily rows, through the existing Blob download, built from the same response the page shows.
  Columns: date, zone, instance, backend, model, tier, profile, input, output, read, write5m, write1h, requests,
  messages, amount, basis, flags.
- **Freshness:**
  - "Updated <time> · read every 10 min".
  - While the scanner catches up, "Scanning — totals may still grow"; it never blocks.
  - "Collected since <date>", and not-collected periods named as such (§5.5).
- **Phone:** rows become cards. The chart scrolls inside its own box, and the page never scrolls sideways.

### Agent read: `get_usage_report`

A new tool. `get_usage` stays the subscription quotas, so neither changes meaning.
- **Arguments:** `range` (`today` | `7d` | `month` | `all` | `{from, to}`), `group`, `instance`, `top`.
- **Returns:** the same rows, with `basis` on every amount ("API-equivalent at list price (checked <date>) — not money
  spent"), and the "estimate", "not reported", "not priced" and "not measured: <reason>" marks in words.
- **Scope:** as `get_cache_report`. General, coordinators and full profiles see the fleet; any other instance sees its
  own row.

## 5. Data contracts

### 5.1 Keys and provenance

The ledger's hourly key becomes **`model|tier|profile`**:
- **`tier`:** the long-context price tier, as today. It is never dropped, so any day can be priced again.
- **`profile`:** the credential profile **the measured transcript came from**.
  - **claude-code:** known from the config dir the file was read in. Each profile has its own.
  - **codex:** recorded as `unrecorded`. Profiles only swap `auth.json`, and a rollout doesn't say which login wrote
    it.
- **backend:** known from the reader that produced the row.
- **Existing data:** ledger hours written before this change read as profile `unknown (before #2122)`. They are never
  relabelled with today's setting.

So an instance that moves from profile A to B keeps A's history under A. Grouping by team is the one view built from
current settings, and it says so.

### 5.2 Two tiers, one checkpoint, each hour counted once

- **Tier H, hourly:** the ledger itself, the last 31 days, recomputed by the scanner as today. A view over these days
  sums the ledger's hours directly (replace, never add).
- **Tier D, daily:** `usage-days.json` per instance, beside the ledger, 0600, written atomically. It holds rows
  `{date, zone, model|tier|profile → totals}` for hours **older** than the ledger keeps, up to 400 days.
- **The checkpoint:** `foldedThroughHour` (a UTC hour) is stored in tier D.

The invariant is that an hour is in D if and only if it is at or before the checkpoint; otherwise it is only in H. A
view is D up to the checkpoint plus the ledger after it.

**Fold, then prune**, the ledger's prune step changed:
1. Take the ledger hours about to age out that are **after** the checkpoint. Add them to their D rows. Write D with
   the new checkpoint (atomic rename).
2. Only then let the ledger drop hours at or before the checkpoint, and write the ledger.

- **Crash after step 1:** D has those hours and the ledger still has them. The next pass folds nothing at or before
  the checkpoint, and simply finishes the prune.
- **Crash before step 1 completes:** nothing moved. The next pass retries.
- **The rule that makes it safe:** the ledger never prunes an hour after the checkpoint. A ledger loaded after a long
  stop folds before it prunes.

**Late data:** a transcript line timestamped before the checkpoint is dropped and counted in the instance's
`late_dropped`, shown as "some late data not counted". The scanner reads only files changed in the last 31 days, so
this is rare.

### 5.3 Days and timezones: hour granularity, zone recorded

- **The approximation:** days are built from UTC hours. In a zone whose offset isn't a whole hour (India +5:30,
  Nepal +5:45), a day's boundary falls on the hour that contains local midnight. The page and the tool say "days at
  hour granularity". This is stated, not hidden.
- **Each D row records the zone** it was folded in. Changing the fleet's timezone re-buckets only tier H, which is
  rebuilt from hours.
- **D rows keep their zone.** Where a date appears both as an older-zone D row and a new-zone H day, the page shows
  both parts under that date with a "timezone changed" note. The UTC-hour checkpoint makes overlap and gaps
  impossible.
- **Changing the zone back and forth** only changes which zone later folds use.

### 5.4 Messages: delivered, once, by receipt

- **Where it's counted:** a per-instance hourly counter, the SQLite table `usage_message_hours(instance, hour, count)`
  in the delivery database.
- **When it's incremented:** **in the same transaction** as a human receipt's **first transition to `delivered` from
  any other state**. `settleHumanReceipt` moves any non-delivered state to `delivered`, and never moves a receipt
  that is already `delivered`. So:
  - `queued → delivered` counts once;
  - so does `queued → uncertain → delivered`, when positive proof arrives later;
  - a receipt that stays `uncertain` or `failed` never counts;
  - a repeated settle of a delivered receipt changes nothing, because the guarded UPDATE matches no row and the counter
    isn't touched.
- **Which hour:** the hour of the receipt's actual `delivered_at`, not its admission.
- **A delivery at or before the checkpoint:** this can only happen when the wall clock went back past the checkpoint
  (§5.2), and then the current hour is behind it too. Such a delivery is **not placed on any hour**. It goes in a
  separate per-instance counter, `usage_message_late(instance, count)`. The checkpoint never folds or prunes that
  counter, and it is incremented in the same transaction.
  - **On the page and in the tool:** "N delivered messages with a clock before the collected period (not placed on a
    day)". The receipt keeps its real `delivered_at`, and no hour is invented for it.
- **What it's called:** the page, the tool and the CSV call it "delivered messages".
- **Receipt retention doesn't matter:** receipts are pruned after `retention_days` (30 by default), but the counter
  isn't a scan of receipts.
- **Folding:** at the checkpoint, the same fold step moves counter rows into D, writes D, then deletes the rows at or
  before the checkpoint. A crash in between leaves rows at or before the checkpoint, which are skipped and deleted
  next time.

### 5.5 Coverage: what was read, not what was used

An hour with no ledger bucket can simply be an idle hour: the ledger makes a bucket only when a turn happened. So
coverage is recorded **by the scanner**, never inferred from missing buckets.
- **Collection starts at fleet start.** It doesn't wait for the page to be opened: the existing lazy `CacheService`
  timer starts at boot, bounded the same way, at 16 MB a pass.
- **Coverage intervals:** each instance's D keeps a short list of merged UTC intervals `[from, to]`. A pass that
  finishes **caught up** at time T adds `[T − 31 days, T]`, since every source changed in that window has been read up
  to T. Adjacent and overlapping intervals merge, so the list stays short.
- **Each hour is one of:**
  - **covered:** inside an interval. No bucket there means **0**, a real zero.
  - **not caught up yet:** after the last caught-up time, while the scanner works. "Scanning — totals may still grow."
  - **not collected:** outside every interval, for example before the first pass or while nothing was read for longer
    than the read window. The page says "not collected", **without a reason**.
- **No reason is inferred.** A pass time followed by a restart doesn't show the fleet was down in between. It may have
  run until a crash a minute before the restart. So an uncovered period is only ever "not collected", whatever the
  pass and start times say.
- **On the page:** "Collected since <first interval>"; "all" means all that was collected; the heatmap draws
  not-collected days differently from zero days.

### 5.6 Serving and memory

- **Snapshot only:** the page and the tool read a snapshot built from the in-memory ledgers, D rows and counters. It
  sums days and never reads transcripts.
- **Handlers never scan or fork** (tool-handlers-never-fork).
- **Memory:** D is about 400 × models × profiles small arrays per instance; H is unchanged.

## 6. Access (fleet decisions a94a1bab, a78ebdc5)

- **Admins:** signed-in admin sessions see it by default, with no switch. `web.usage_panel: false` already hides usage
  everywhere, and it hides this page too.
- **Guests:** never. Not in `GUEST_ROUTES`, and refused even when the public-link key below is on.
- **The public link:** off unless an admin sets `web.usage_report_on_public_link: true` (one key, documented in
  configuration.md en and zh-TW).
  - **The data it guards:** up to 400 days of per-agent, per-model, per-profile activity and amounts. That is more than
    today's live quota rail or the cache report's 7-to-30-day summary, which the public link already shows, and it is
    the reason for the key; the outward origin alone isn't.
  - **One gate:** the route and the CSV share it, since the CSV is built from that route's response.
  - **When blocked:** the page says "Not offered over the public link", with a link to Settings → Web on the local
    dashboard.
- **Agents:** as in §4's scope.

## 7. Evidence (fleet decision a78ebdc5)

A from-defaults smoke on the realistic fixture, with transcripts in the real Claude and Codex shapes from
`tests/fixtures`. It uses a fresh profile with no seeded prefs, only the visible UI, desk 1366 and phone 390, light and
dark, and prefers-reduced-motion on.

It covers:
- the ranked rows and their numbers against the fixture's known totals;
- the estimate mark on a codex row;
- "not priced" for an unknown model;
- "not measured" for kiro, grok, agy, muse and opencode, each with its reason;
- the empty state ("Nothing recorded yet — usage is read from Claude Code and Codex transcripts");
- a covered idle period (zeros) beside a not-collected period;
- the public link, both blocked and opted in;
- a guest, absent;
- the CSV download's rows and `basis` column.

Each state is screenshotted and its message asserted. Unit tests pin §5:
- fold idempotence across a crash at each step, and the never-prune-past-checkpoint rule;
- profile provenance across a profile switch, and zone recording;
- messages counted once: `queued → delivered`, `queued → uncertain → delivered` and a repeated settle all count 1,
  and a receipt left `uncertain` counts 0, in the hour of `delivered_at`;
- coverage: a fleet running all day but used only at 09:00 and 17:00 reads 10:00–16:00 as covered zeros. An interval
  before the first pass reads "not collected".
- a pass at 09:00, the fleet still running until 09:59, then a restart at 10:00: no hour reads as "stopped". What isn't
  inside a coverage interval reads "not collected".
- the wall clock set back before the checkpoint: a delivery then goes to `usage_message_late`, never onto an hour the
  checkpoint skips or prunes, and the next fold neither drops nor double-counts it.

## 8. Docs and skills, in the same PR

- `docs/web-dashboard.md` and `docs/features.md` (en and zh-TW).
- `docs/configuration.md` (en and zh-TW): the public-link key.
- The `web-dashboard` skill: where the page is, what the labels mean, `get_usage_report`, and "say API-equivalent".
- The MCP tool's description.

## 9. Staging

1. **Server:**
   - the ledger key with profile;
   - fold-then-prune with the checkpoint;
   - `usage-days.json`;
   - the message counter;
   - collection at boot;
   - the snapshot;
   - `GET /ui/usage-report`;
   - `get_usage_report`;
   - tests on real transcript shapes.
2. **The page:** Fleet → Usage (rows, group by, ranges, trend, heatmap, CSV) and the dialog's link, with the smoke,
   docs and skill.
3. **2.4:** readers for Kiro (once real `request_metadata` carries tokens) and OpenCode (tokscale's schema, verified
   offline); then Grok and Muse. Claude subagent and sidechain usage, if wanted.
