# Ended-code browser feedback correction

B2 integration exposed a feedback gap: a normal administrator revoke already retires a pending request. The later browser approval hit the general stage conflict before reaching the existing code-ended classifier. The new fail-first test opens the real Origin/state-bound browser flow and signs in before the actual revoke; it observed the wrong conflict response.

A current directory actor and exact current record are still required. An ended, unissued code request whose code is no longer live now returns the existing authenticated browser denied/code-ended feedback. Issued requests and policy retirement with a still-live code keep the original conflict/recovery behavior. The pending admission, issuance/CAS, budgets, required audit and machine answers are unchanged.

The five B1 suites pass69/69, zero skips; both native typechecks pass. Three selected controls pass (20 deliberately unselected). Two isolated, compiling mutations each fail one intended semantic assertion and keep the other two controls green; exact source is restored before the69-test run. Hash binding and boundaries are in receipt.json. A preliminary test fixture incorrectly opened the browser after revoke; that was discarded and corrected before the reported fail-first run.

The earlier reviewed source is fcc9ebbce; this correction needs a new exact-head Prism verdict and CI. Existing runtime/PNG/rollback evidence remains historical and is not recast as a new run. The combined B2 campaign is separate. Reverting this correction restores generic feedback only; reverting all B1 still requires its documented complete private backup for downgrade.
