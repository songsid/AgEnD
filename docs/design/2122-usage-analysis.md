# #2122 Usage analysis per agent

Status: design, no code. Proposed target: 2.3 for the measured backends (Claude Code and Codex); the other backends
show as "not measured" in 2.3 and get readers in 2.4 when their data is proven.

## 1. What the user asked for

The user's Discord request (hmsg-6bf9f0f1, relayed by the leader) wants tokscale-style usage analysis in the web
dashboard. The example was an external "family usage cost split" page:
- range tabs (today / 7 days / this month / all);
- an "updated at … (cached ~2.5 min)" line;
- ranked rows per agent, each with:
  - a cost and a proportional bar;
  - input, output, cache read, cache write and total tokens;
  - a message count.

## 2. Data: what AgEnD can measure today

Almost everything already exists in the prompt-cache report's ledger (#1468, #2010, #2030):
- `CacheService` scans transcripts incrementally, in the background, with a byte budget.
- It attributes each transcript to an instance.
- It keeps **hourly totals per model**, `[requests, uncached, read, write5m, write1h, write, output]`, for 31 days, in
  `~/.agend/instances/<name>/cache-ledger.json`.

| Backend | Source | Input | Output | Cache read | Cache write | Model | Status in 2.3 |
|---|---|---|---|---|---|---|---|
| claude-code | `<config dir>/projects/<key(cwd)>/*.jsonl` (the credential profile's dir) | ✓ | ✓ | ✓ | ✓, split 5m / 1h | ✓ | **measured** (subagent and sidechain lines excluded; noted) |
| codex | `$CODEX_HOME/sessions` rollouts, by `session_meta` cwd | ✓ | ✓ | ✓ (`cached_input_tokens`) | recorded as **0** by every CLI seen so far | ✓ | **measured; cache write unknown**, never priced as uncached |
| kiro-cli | `conversations_v2.history[].request_metadata` has token fields | ? | ? | ? | ? | ✓ | **not measured**: every field is null in the only fixture; billed in credits. Shown as such. |
| grok, antigravity, muse | no known per-request token store | — | — | — | — | — | **not measured** |
| opencode | `opencode.db` probably holds usage (`opencode stats`), schema unknown | — | — | — | — | — | **not measured** (a 2.4 reader if the schema is confirmed offline) |

A **request** is one model call: an assistant turn or a tool loop step, as the transcript records it. The ledger
measures this today.

A **message** is a human message delivered to the instance. AgEnD counts these itself: one human receipt per
delivered Discord, Telegram or web message. This answers the screenshot's "messages", and it is measured for every
backend, even the ones whose tokens are not.

Where the instances come from, unchanged: fleet.yaml instances plus ClassicBot rooms (`cacheInstances()`). Instances
that share a working directory are `shared` and not split (as in the cache report). The view shows them as "shared
with …", never as zero.

## 3. Cost: list-price equivalent, never "spent"

- **Prices:** `src/cache-prices.ts` (`TABLE`, `PRICES_CHECKED`, `PRICE_SOURCES`), the same table the cache report
  uses. It holds standard-tier list prices per million tokens. Claude cache writes are 1.25× input (5m) and 2× input
  (1h); a long-prompt row applies over the threshold. The table is updated in code, with its "checked" date, like
  today.
- **Label:** every amount is **"API-equivalent at list price (checked <date>)"**. A subscription is not billed per
  token, so the page never says "spent" or "cost you". The header shows the subscription plans from `/api/ai-usage`
  next to it as context, not as a sum.
- **Honest gaps:**
  - **Unpriced model:** its tokens show, and the cost says "not priced". The rest of the instance still sums, with a
    "partial" mark; it doesn't switch to units as the cache report does, because this view is about totals.
  - **Codex cache writes:** shown as "not reported", never 0, and left out of the cost with an "estimate" mark. Codex
    input is therefore never priced as if nothing was cached.
  - **Not measured** (kiro and the rest): no amount, and the reason ("kiro bills in credits", "this CLI records no
    token usage AgEnD can read"). It is never a $0 row ranked at the bottom.

## 4. Views

The page is **Fleet → Usage** (`/ui/fleet/usage`), next to Cache. There is no usage page today: the ◔ button opens a
rail and a dialog of subscription quotas. That dialog gains a "By agent →" link to this page.

- **Ranges:** today, 7 days, this month, all (everything kept, §5), and a custom from–to. Days follow the fleet's
  timezone (`scheduler.default_timezone`, else the host's).
- **Rows:** per instance by default, ranked by cost (tokens where unpriced). Each row has:
  - a proportional bar;
  - input, output, cache read and cache write, total tokens;
  - requests and messages;
  - its backend, model(s) and credential profile.
  The "not measured" and "shared" instances are listed under the ranked rows with their reason.
- **Group by:** instance (default), backend, model, credential profile, team (fleet.yaml teams). Grouping by person
  is not offered: tokens can't be attributed to whoever wrote a message. It would be a guess.
- **Trend:** a stacked daily bar chart (cost, or tokens when unpriced) for the range, with the top 5 instances and
  "others". Below it is a calendar heatmap of daily totals over the kept history, like tokscale. Both follow the
  `dataviz` skill: an accessible categorical palette defined as tokens in light and dark, and text labels and
  `aria` descriptions so colour is never the only cue.
- **Export:** CSV of the daily rows (date, instance, backend, model, profile, input, output, read, write, requests,
  messages, cost, priced/estimate flags), through the existing Blob-download pattern.
- **Freshness:** "Updated <time> · read every 10 min". While catching up, it shows "Scanning — totals may still grow",
  with no spinner that blocks.
- **Phone:** the rows become cards; the chart scrolls horizontally inside its own box, and the page never scrolls
  sideways.

### Agent read: `get_usage_report`

It is a new tool. `get_usage` stays the subscription quotas, so neither changes meaning.
- **Arguments:** `range` (`today` | `7d` | `month` | `all` | `{from, to}`), `group` (as above), `instance`, `top`.
- **Returns:** the same rows, with the labels in words ("API-equivalent at list price", "estimate", "not measured:
  <reason>").
- **Scope:** the same as `get_cache_report`. General, coordinators and full profiles see the fleet; any other
  instance sees its own row. General can then answer "how much did each agent use this week".

## 5. Rollups and performance

- **Daily rollup:** a small file per instance, `usage-days.json`, beside `cache-ledger.json`. It holds
  `{ day → { model → [requests, uncached, read, write5m, write1h, write, output] } }` in the fleet's timezone.
  - **When it is folded:** after each ledger pass, the ledger's hourly buckets fold into it; only the hours that pass
    touched are re-added.
  - **What it adds:** the ledger keeps 31 days; the rollup keeps **400 days**, which makes "all" mean something.
  - **Memory bound:** about 400 × models × instances small arrays.
  - **Format:** written atomically, 0600.
- **Messages:** counted per instance per day from the human receipts at admission, a counter folded into the same
  rollup. Nothing scans the receipts table for this.
- **Serving:**
  - The page and the tool read a snapshot built from the in-memory rollups. That is cheap: it sums days, never reads
    transcripts.
  - **Handlers never scan or fork** (tool-handlers-never-fork).
  - Opening the page wakes the existing lazy `CacheService` timer; the first answer can be "scanning" with what is
    there.
- **Timezone change:** the rollup keeps UTC hours for the last 31 days and re-folds those under the new zone. Older
  days keep the zone they were folded in, and the page says so.

## 6. Access (fleet decisions a94a1bab, a78ebdc5)

- **Admins:** signed-in admin sessions see it by default, with no switch. `web.usage_panel: false` already hides usage
  everywhere, and it hides this page too.
- **Guests:** never (not in `GUEST_ROUTES`).
- **The public link:** not by default. An admin opts in with `web.usage_report_on_public_link: true`. This is the one
  new key, and the threat it stops is token and cost totals of every agent reaching an outward link.
- **Agents:** as §4's scope.

## 7. Evidence (fleet decision a78ebdc5)

A from-defaults smoke on the realistic fixture, with transcripts in the real Claude and Codex shapes (from
`tests/fixtures`), a fresh profile, no seeded prefs, and only the visible UI. It runs at desk 1366 and phone 390,
light and dark, with prefers-reduced-motion on, and covers:
- the ranked rows and their numbers against the fixture's known totals;
- the estimate mark on a codex row;
- "not priced" for an unknown model;
- "not measured" for kiro, grok, agy, muse and opencode, each with its reason;
- the empty state ("Nothing recorded yet — usage is read from Claude Code and Codex transcripts");
- the public link (not offered, unless opted in);
- a guest (absent);
- the CSV download's rows.

Each state is screenshotted and its message asserted.

## 8. Docs and skills, in the same PR

- `docs/web-dashboard.md` (en and zh-TW): Fleet → Usage.
- `docs/features.md` (en and zh-TW).
- `docs/configuration.md`: the public-link key.
- The `web-dashboard` skill: where it is, what the labels mean, `get_usage_report`.
- The MCP tool's description.

## 9. Staging

1. **Server:** `usage-days.json` rollups, the message counter, the snapshot, `GET /ui/usage-report`,
   `get_usage_report`, and tests on real transcript shapes.
2. **The page:** Fleet → Usage (rows, group by, ranges, trend, heatmap, CSV) and the dialog's link, plus the smoke,
   docs and skill.
3. **2.4:** readers for kiro (once real `request_metadata` is proven to carry tokens) and opencode (once its schema is
   confirmed offline). Claude subagent and sidechain usage, if wanted.
