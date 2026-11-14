# Hub version recommendations — phase 2 API (M-3138)

Advice only. No updater launch or remote-install authority. Companion UI cards own banners, chat reminders and local
admin confirmation. Default is no saved recommendation. The unsaved UI may select `hub` by default.

## Hub administration

`GET /hub/v1/admin/recommended-version` (Hub admin):

```ts
{ mode: 'hub'|'specific'|'none', version: string|null, recommendedVersion: string|null,
  hubVersion: string|null, configured: boolean, revision: number, setAt: number|null }
```

`version` is the specific literal; effective target is `recommendedVersion`. Unconfigured returns `none`, nulls,
revision 0. `hub` follows the running Hub after restart, advancing revision/time only when that version changes.

`POST .../preview {mode,version?}` returns `{recommendedVersion,affected,revision}` without saving. Affected counts
active Fleets below the target plus unknown-version Fleets, including older Fleets that cannot receive advice.
`PUT ... {mode,version?,ifRevision}` saves and returns the GET shape. Both writes require CSRF + current admin/session.
Both validate an exact SemVer and check `@songsid/agend@<version>` on npm. The process uses the install's npm environment,
fixed argv, 15-second timeout and 16-KiB output limit; same-version checks coalesce, at most four run per instance.

Refusals: 400 `version-invalid`; 422 `version-not-found` with validated `version`; 503 `npm-unavailable` with validated
`version`; 503 `hub-version-unknown`; 409 `revision-conflict`. Ordinary authorization/CSRF/shape errors are unchanged.
A competing save or session change during npm cannot commit. Preview is advisory; PUT validates again.

Overview and `/me/fleets` compare against the effective recommendation. Overview adds
`fleets[].recommendationNotifiedAt:number|null` for the current policy revision. This means acknowledged verified
local offer, not proof the owner read it or installed it. Current/non-newer and withdrawn policies have no notified time.

## Transport and compatibility

Hub-only offer `fleet-recommend-v1` occupies the 16th welcome slot. No new member hello name: hello still sends at most
16. The current member opts in with `fleet.info.payload.recommendations:true`, only after seeing both `fleet-info-v1`
and `fleet-recommend-v1` with welcome capabilities. Old Fleets omit the value, so the Hub never sends them new frames.
A current Fleet connected to an older Hub neither sends that field nor expects advice.

After reconciliation the Hub sends `fleet.recommendation` with `{revision,setAt,version:string|null}`. No free text,
origin, command or package name. The authenticated selected member database retains the latest candidate and rejects
older/conflicting revisions. Independent npm verification is asynchronous, outside the member control receive queue.
Only a newer published version produces an offer; null clears, equal/older marks current. A failed npm read produces
no offer/ACK and can retry. `fleet.recommendation-ack` carries `{revision,version,status:'offered'|'current'|'cleared'}`.
Hub accepts only its exact live-link/revision/version send. Unacknowledged live sends retry every 30 s; reconnect
resends even after ACK so the selected Fleet refreshes its state. Offline fleets have no polling timer.

## Fleet update host

`HubRecommendedUpdate` is exported from `src/hub/recommendation-model.ts`:

```ts
{ hubId, hubName, version, revision, setAt, receivedAt }
```

`FleetManager.hubRecommendedUpdate():HubRecommendedUpdate|null` synchronously returns cached verified advice.
`FleetManager.onHubRecommendation(fn):()=>void` observes visible change/clear and restored advice after attachment.
`WebUpdateHost.updateState().hubRecommendation` and the admin `/ui/update` response expose that value. Non-admin view
remains `{admin:false,current}`. `hubName` uses the paired Hub web hostname, the available local Settings label; it is
not untrusted text sent with a recommendation. Ordinary link outage keeps advice. Local disconnect/disable/fence or
rebind clears the view; newer null/non-newer policy clears it. Verified advice survives restart in that pairing's DB.
An install must still re-resolve the same revision/version at confirmation and independently check npm; this slice
never invokes `startWebUpdate`.

## Limits and rollback

Follow-Hub changes derive from the installed Hub version, without npm I/O on GET; each receiving Fleet still verifies
that release before offering. Stored candidates are diagnostic advice and may be retried, never execution records.
Disable the feature offer or revert the code to stop advice; retain additive migration tables. No user data is deleted.
