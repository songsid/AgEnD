# Hub administration dashboard API

M-3161 implements the approved M-3147 mockup, read at `docs/hub-ux-review-m2902` / `673782a4`. M-3162 supplies the page. The existing `/hub/v1/admin/overview` Fleet-management response is unchanged.

Browser sessions advertise `admin-dashboard-v1` when this dashboard route is composed. The page can select its first tab from `session.features` without probing the route; an older Hub omits the feature. A 404 remains a quiet Manage-tab fallback. This is browser composition metadata, not a member-link capability.

`GET /hub/v1/admin/dashboard?range=today|7d&timeZone=<IANA>` requires the current Hub administrator (`hub.admin` management permission). Defaults: `range=7d`, `timeZone=UTC`. Unknown/repeated query keys, other ranges and invalid zones return 400. Other methods return 405. Signed-out callers get 401; signed-in non-administrators get 403. Normal session/directory fences apply through the read transaction.

The response contains:

```ts
{
  generatedAt: number, range: 'today' | '7d', timeZone: string,
  start: number, end: number,
  people: { total, activeToday, active7d, joined7d, signedInNow },
  questions: {
    asked, perDay: { date: 'YYYY-MM-DD', count: number }[],
    answerTime: { medianMs: number | null, p90Ms: number | null, samples: number },
    waiting, longestWaitMs: number | null,
    notAnswered: { total, reasons: { offline, timedOut, permissionEnded, stoppedOrRefused, unknown } }
  },
  topAgents: { id, name, ownerName: string | null, questions, medianMs: number | null, notAnswered }[],
  sharedAgents,
  fleets: { total, connected, needsUpdate, tooOldRooms, unknownVersion, recommendedVersion: string | null },
  rooms: { total, active, created7d, messages, byAuthor: { people, agents, assistant }, agentQuestions, chainsStopped }
}
```

Unannotated counts are nonnegative integers. `topAgents` contains at most five rows, ordered by questions descending, exposure ID as the stable tie-breaker. Only agent IDs, agent display names and their owner display names appear; no person identifiers, room identifiers/names, prompts, answers, file names, token counts or costs are returned. The endpoint never reads/decrypts content or audit content. It adds no per-person activity records.

## Windows and units

Today starts at midnight in the supplied viewer zone. Seven days means today and the preceding six local calendar dates, including DST day lengths. `end` is the inclusive server snapshot time; future-dated records are excluded. The seven bars always cover those seven dates, even when Today is selected. People cards retain their explicitly named windows. Waiting and longest wait describe current outstanding work across all dates. Other activity uses the selected range, attributed to the question's creation time.

One stored target question counts once: a direct shared-agent question or one Fleet-agent room delivery. An `@All` question contributes each target. Room-assistant calls are excluded from Questions, latency, failures and top agents; assistant answers remain in the Rooms message split. This unit and exclusion were confirmed by Lumen on M-3161.

People totals use successful-sign-in witnesses in `hub_people`; activity uses distinct people with a retained session's latest `seen_at`, not eligibility-check times. Joined this week uses the earliest retained session creation, not repeated sign-ins or successor sessions. Signed in now additionally requires an active, unexpired current-directory session, an active person and activity within five minutes. The sign-in activity is a latest-observation measure, not a historical daily people series.

Median is the middle value (mean of the middle two for even samples). P90 uses nearest rank. Both remain null below five timed answers in the range, including each top-agent median. UI copy: “Not enough answers yet” / 「回答數還不夠」. Old answered questions with no reliable timestamp contribute to questions but not latency samples. The total hint is “Each agent asked counts once.” / 「每問一個 Agent 算一次。」.

## Sources and limits

- Direct questions: `hub_messages`. Room-agent questions: `hub_room_deliveries`. Answer time is the new immutable `answered_at`, written in the successful disclosure transaction. Duplicate answers and later receipts cannot change it; refused/retired answers do not obtain a time. Direct `stage_at` is mutable on later receipts and is deliberately not substituted. Historical timestamps remain null.
- Not answered: no accepted answer, plus a stored terminal/uncertain outcome or an elapsed expiry. `expired` maps to timedOut; `revoked/denied/stale/retired` to permissionEnded; `incompatible/interrupted/rejected/stopped/refused` to stoppedOrRefused. Only an explicit offline reason can populate offline. Existing `unavailable/uncertain` or missing reasons are unknown; lack of dispatch does not prove offline. The four mockup reason groups therefore have an additive unknown fallback rather than a fabricated explanation. Waiting excludes held uncertain outcomes and elapsed expiry.
- Fleets use the active authoritative Fleet population and the same version-state/live-link helper as Connected Fleets. `needsUpdate` is the `needs-update` state; too-old and unknown are separate counts. Shared agents are current published, unfrozen exposures matching an active Fleet owner. Historical top-agent names use the currently retained exposure/owner labels, or a neutral missing-agent label.
- Rooms include retained group rooms (archived history included), excluding private Hub-assistant 1:1s. Active means at least one visible message in the range. Messages exclude system lines and queued/working/not-answered placeholders. `agentQuestions` counts room Fleet-agent deliveries, not person reminders or assistant calls.
- Chain stops count one coalesced depth/rate stop. The migration aggregates retained historical stop rows without reading their text. New stops update a global minute/reason counter in the same transaction as their room/audit event. It retains no room, agent or person key, survives later post deletion, and prunes buckets older than nine days on the next stop. Other stop reasons do not contribute.
- Questions and messages are limited by ordinary Hub retention. No deleted content/history is reconstructed. The response reads metadata and exposes aggregates; it does not grant the administrator room membership.

## Migration and rollback

Additive `s3-admin-dashboard` v1 adds `answered_at` to direct questions and room deliveries plus global `hub_chain_stop_counts` and time indexes. Existing answer/payload bytes and identities are untouched. Older migration registries refuse the new component. Rollback disables the dashboard route/UI or restores a pre-migration backup with the matching older binary; never delete the new columns from a live database. No actual Fleet update, external AD, vendor API or browser campaign is required for this server-only change.
