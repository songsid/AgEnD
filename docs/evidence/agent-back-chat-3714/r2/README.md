# R2: align View identity and header contracts

CI43217816497 and Fable identified two additional stale pins outside the original focused list. Both reproduce at7930de51: two assertion failures/36 controls across `sidebar-instance-identity` and `web-usage-rail-1673` ([before receipt](before.json), [log](before.log.gz)).

The signed-in View roster’s selected agent deliberately returns to Chat under #3714; its other row still links to View, and public View retains its existing control. The updated identity test pins both hrefs and retains tooltip/name/active-marker assertions. The header test now expects the extra Settings return control, preserving the exact other three shapes, text-size names, tab labels and Log slot assertions. Product source is unchanged.

Clean test/evidence head `a133e1ac3` passes **74/74 across four suites**, with one worker: usage, identity, n1 and back-chat. Native TypeScript7 test checking passes ([receipt](receipt.json)). Three syntax-valid reversals each trigger the changed tests: remove selected-row rule, send other rows to Chat too, or remove the Settings X. Each restores source exactly before the final74 pass; [reversal receipt](mutations/receipt.json), [runner](reversals.py).

[Parity](parity.json) proves the full src/scripts/changes/browser Git objects equal7930de51. Original geometry binds the visible Settings X to36×36 on every desktop theme/language capture and44×44 on phone. All42 PNGs/20 receipts remain byte-identical; no new browser execution is claimed. Prior source/visual/SKEW scopes carry. Fresh exact-head CI and Fable verdict remain required; #3732’s user hold/dependency remains.
