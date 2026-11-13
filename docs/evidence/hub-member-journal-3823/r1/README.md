# R1: exact review pins

Production source is byte-identical to reviewed `a8e56a67a`; the delta is tests/evidence only. All 48 cases across the
two changed files pass after restoration, and native test types exit 0. Seven isolated reversals compile with native
source types and fail assertions; exact source bytes are restored. Original eleven reversal receipts remain historical
and unchanged. No broad suite, browser or live operation was rerun for R1.

| Reversal | Contract exercised |
|---|---|
| K2 | Complete scoped history is used when legacy files are absent or partial; the real link sends the retained scoped ID and creates no legacy files. |
| K8 | S4 source matches but context digest differs: uncertain, with corrected-digest adoption positive. |
| K10 | Missing pairing with existing published consent: offline refusal, preserving the row and the caller's unsaved path. |
| K13 | Representative source matches but exposure revision differs: uncertain, with corrected-revision positive. |
| K5 | A bound retained read rejects selectively restored/corrupt foreign binding metadata without prepare. |
| K11 | The actual private fixture profile changes after production bind; offline withdrawal refuses before modifying consent. |
| K12 | Composition's current fence changes after its first read; no stale service is returned. |

Run `python3 docs/evidence/hub-member-journal-3823/r1/mutate.py` for the isolated reversals and the two changed test files
with `vitest run --maxWorkers=2` for restoration. `bindings.json` records the two unchanged production inputs and two
changed fixtures. Logs use only synthetic fixture data and owned temporary files.

Count correction: the original 168/8 and 65/4 runs overlap by 40, yielding 193 distinct cases, rather than the previously
reported 194. Outcomes are unchanged. R1's 48 tests overlap those original runs; they are not 48 additional cases.
