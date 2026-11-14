# Scoped Team review repairs

Ridge's actual-server walk found that PATCH returns the stored Team without memberInfo or canManage. The editor replaced its detailed view with that DTO, so names became immutable IDs and roster actions disabled. The editor now applies the stored Team while retaining known draft member names and presentation, then uses the existing fenced detail read for fresh metadata, permissions and status. A new Team still enters its ordinary detail mount. Complete detail responses keep the existing path.

The partial-response control is assertion-red before the fix (one selected failure, eight deliberately skipped). It checks Saved plus readable existing/new names and an enabled Remove action while the detail read is held, then verifies fresh detail replaces retained presentation. A first candidate run hit the mini-DOM's space-containing attribute selector limitation; its log is retained as selector-failure.log, excluded as a product failure. The same assertion now finds the exact aria-label among button nodes; the selected control passes.

Fable's detail P2 is fixed before the lead directory read: only the administrator or exact current lead may GET details. A plain member is denied and spends no lead read; both allowed actors remain positive. The all-Team list DTO still carries canonical roster IDs in this pilot (non-blocking P3); a separate compact public list projection can remove those later without changing this repair's reader contracts.

Web owner's title P2 is fixed by keeping Teams under the panel's title effect. The nullable suggestion Team ID P3 is also fixed and the person fallback is explicitly documented as old/fixture-server compatibility. Three selected review controls are assertion-red before those fixes (21 unselected); the affected provider/UI/client files then pass24/24. This overlaps prior controls and must not be added to earlier campaign totals.

No new mutation, browser, TLS or native campaign; exact CI must settle on the new head. Earlier8b831 UI/gallery/gate evidence retains its original scope. Ridge resumes only the affected actual-server walk, without a new matrix.
