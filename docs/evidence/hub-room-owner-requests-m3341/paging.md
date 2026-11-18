# Retiring a superseded request page

The review found that a held Load more response could append an old pending row after a newer page omitted that cancelled request, and overwrite the new cursor.

The rows component now changes its operation identity during render whenever the page or room changes. A layout effect resets the old extra rows, cursor, error and loading state before the refreshed controls are usable. A response from an older identity returns without altering the current operation or its loading state.

Mounted tests use deferred API responses, with no network or timing sleeps:
- Refresh while a page is held, then release its cancelled row and old cursor: neither returns. A current positive response appends its row and consumes the fresh cursor.
- Refresh the page or switch rooms, start a new operation, then release the superseded response: it neither appends stale data nor unlocks the current operation.

Before the fix all three cases fail, including the cancelled-row assertion. With the fix, the request UI plus room settings/client regression set passes **27/27**. Removing the generation check turns all three cases red. After restoring it, the request UI passes **13/13**. The test TypeScript check exits 0.

The correction changes no backend, markup or copy. The previously accepted rendered views remain the visual evidence; no browser, identity, CLI, model, Windows or native campaign was repeated. See [paging-control.json](paging-control.json).
