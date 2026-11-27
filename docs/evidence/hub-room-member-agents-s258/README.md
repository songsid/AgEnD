# Room members adding their own agents

Room managers can enable **Members can add their own agents**. Existing and new rooms default off. With it on, a current member can add only agents they own and have shared on this Hub, using a picker scoped to that room. All room members can then ask the agent in the room. Managers can remove it; switching the setting off retains existing agents.

The member flow does not expose manager settings, add people or assistants, invite another owner's agents, or change the manager-only **Ask its owner** flow. For another owner's agent, members ask a room manager. The existing owner-removal and manager-removal rules remain in place.

## Captures

Four selected cases: English and Traditional Chinese at desktop1366×900 and phone390×844, dark theme. Each has four full-viewport originals: manager setting off/on, member own-agent picker, and the added agent in the members panel. Open [manifest.json](manifest.json) for exact file hashes, ten source bindings, browser version and all46 positive checks (shared checks overlap between cases).

| Case | Default off | Enabled | Member picker | Added |
| --- | --- | --- | --- | --- |
| Desktop EN | [off](browser/desk-en-manager-off.png) | [on](browser/desk-en-manager-on.png) | [picker](browser/desk-en-member-picker.png) | [added](browser/desk-en-member-added.png) |
| Desktop zh-TW | [off](browser/desk-zh-TW-manager-off.png) | [on](browser/desk-zh-TW-manager-on.png) | [picker](browser/desk-zh-TW-member-picker.png) | [added](browser/desk-zh-TW-member-added.png) |
| Phone EN | [off](browser/phone-en-manager-off.png) | [on](browser/phone-en-manager-on.png) | [picker](browser/phone-en-member-picker.png) | [added](browser/phone-en-member-added.png) |
| Phone zh-TW | [off](browser/phone-zh-TW-manager-off.png) | [on](browser/phone-zh-TW-manager-on.png) | [picker](browser/phone-zh-TW-member-picker.png) | [added](browser/phone-zh-TW-member-added.png) |

Capture source: `29bba0212187b6a27dc54b3af888f68af127f1b0`, clean working tree. The harness runs shipped UI/HTTP/SQLite/audit over owned local HTTPS, with synthetic people and an inert synthetic Fleet publication. It does not start a Fleet or contact any provider. Dialog animations and fonts settle before pictures. The added view deliberately reloads the page and reopens the phone members sheet; it proves persisted membership, not an immediate live room-list counter update. Phone screenshots can clip secondary content below the settings field; the target control and explanation are shown.

The first capture attempt produced11 frames, then failed waiting for a phone members row because opening the add dialog had closed that sheet. Inspection also found an outdated manager-only empty hint and a stale list counter in the background. The hint was corrected for opt-in member rooms; the harness now explicitly reopens a fresh members view. All16 delivered originals are from the corrected four-case run. Initial frames are not delivery evidence. There was no timeout increase or retry loop.

## Validation and authority

- Fourteen focused controls cover the current real HTTP/SQLite writes, audit, migration and mounted UI. Setting off, foreign ownership, nonmembership, unshared exposures, a different room, attempts to add people/assistants and unauthorized setting changes refuse. Membership, setting and sharing changes across the authorization await refuse before effects; a setting change during the admission audit rolls back both membership and that audit.
- Removing the member opt-in guard makes the default-off control fail with an unauthorized success. Restored source passes. The original baseline also fails the new feature controls as expected.
- The71-test scoped compatibility run covers role creation, owner requests, room migration and the new flow with overlap. Existing manager agent/removal/settings/member controls passed in the earlier focused run; the historical migration fixture was updated to exclude this later migration from its pre-room image.
- Source and test typechecks passed. Public and changelog checks passed. The four HTTP/room-contract suites pass36 tests, including the nine current real HTTP controls (overlap). Final source/test typechecks, changelog and public checks are clean; staged secret scan found no leaks.

No real AD membership, live Hub/Fleet, vendor CLI/model, native phone or OS-keyboard behavior is claimed. Phone is Chromium emulation; other browsers/themes are not covered. The UI hint can lag another viewer's setting change until the normal room refresh, but each write rechecks current membership, room policy, owned publication and authorization. Candidate search is room-scoped and exposes only owned published agents; it grants no room-management authority.

## Migration and rollback

The additive `s3-room-member-agents` migration defaults every existing room to off without changing prior room fields. An older migration registry refuses the new component. No transparent binary downgrade is claimed. To disable the capability, managers turn it off per room; this preserves existing members. A code rollback must retain the schema migration compatibility or use a separately validated database downgrade. Do not restore an older binary against this database blindly.
