# R1 refusal scope and key separation

Source `386f0c03a85e7c602012b2a63406ff32b75dd70e` repairs Fable's P2 on reviewed draft f0a743f7. A withdrawn/unready/stale bounded room refusal is logged and dropped without ending the shared link. Backpressure and unexpected exceptions retain the existing link failure path. No new wire ACK is invented; R owns retry/expiry. The test withdraws an exposure, sends that refused ask, republishes, and delivers a valid question on the same unchanged link epoch.

The optional P3 is also resolved before this composition ships: HKDF-SHA256 derives a room-specific subkey from the existing content key, immutable binding and a dedicated domain. The raw audit key cannot authenticate room rows. No deployed history is rewritten or deleted.

The two new controls were semantic-red on exact reviewed f0a source (nine other cases unselected). Current restored source: **49/49 across four suites**, including all **13 composition cases**, both native TS7 programs exit zero. Three isolated native-compiling reversals fail by assertion: the old link-tearing receive, direct audit-key reuse and swallowing backpressure. Exact restoration and all fourteen source/test/transport/helper bindings are recorded. R0's 185 tests/seven reversals remain historical at their own source; no broader fresh run is claimed.

No browser/PNG/model/real-directory/Fleet/container run. Parent merges, shared UI presence integration/gallery, current CI and ordinary review still hold the draft.
