# R1 — visible selected state beside an icon

Fable's M2 removed both trailing check marks while keeping `aria-checked` correct, and the original tests stayed green. Two parameterised cases now render checked and unchecked icon rows for radio and checkbox roles. They require the leading icon on both rows and exactly one visible trailing check on the checked row only. No existing assertion was removed.

Clean test input: `d49637616e6b6e72f6bc4676027bea9b80ca4b56`. Three compiling reversals are assertion-caught: both check branches removed → 2 failures; checkbox only → 1 failure/1 control pass; radio only → 1 failure/1 control pass. Exact source restoration follows each run. With original source restored, the menu, workspace-entry and favourites suites pass **39/39**. `npx tsc --noEmit -p tsconfig.test.json` passes locally. All tests use one worker and each command starts at load ≤10.

`receipt.json` pins the source/test bytes, commands, results and raw stdout digests. Stdout is losslessly gzip archived. `driver.py` is the exact serial reversal driver; `parity.json` binds it and proves that the entire product source, manual harnesses and all browser receipts/PNGs equal the reviewed R0 head `ca82794ca`. The only code delta is the two tests. Browser/visual/source clearances carry; no new browser run is claimed. Fresh exact-head CI is still required.
