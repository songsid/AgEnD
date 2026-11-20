# Alpha integration after visual approval

Merged alpha f0c44125e75d9a7c05b35828cef98a8e7608f8ef normally to resolve the conflict with the new custom-snack Office feature. The snack tray/ghost rendering and its drag/drop hover guard are retained; the zone controls remain in the approved separate layout row.

A mounted integration control found that an armed snack could be bypassed by the new bubble click. The same actually painted point opens chat normally, consumes snack placement while armed without opening chat, and opens chat again once placement has consumed the mode. This was red before the integration guard and green afterwards. The guard affects armed custom-snack mode only; the approved default views have no custom snack pack.

247 tests in seven affected Office/snack/module files and test TypeScript pass. No provider, account, CLI, browser or Windows campaign was repeated. The merge preserves both sides' behavior, including alpha's already reviewed snack/name-tag rendering changes.

The popup helper, Fleet callback, agent card, dialogue renderer and dedicated stylesheet are byte-equal to approved 9d145cff. The painted-hit geometry, dialogue painter and dialogue activation blocks are also byte-equal. New changes are limited to the interaction-mode guard and integration with the base.

The R1 originals and source hashes identify their 9d145cff capture snapshot. They have not been silently rewritten as a new capture campaign. All image bytes and approved row styles remain unchanged; incoming base behavior is preserved. This is source/integration proof, not a claim of new screenshots on this merged tip.

Rollback remains a revert of this PR's presentation/test changes, preserving the base's snack feature. No data, authentication, CSP or protocol migration is introduced.
