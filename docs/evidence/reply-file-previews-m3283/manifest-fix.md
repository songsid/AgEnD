The #4109 squash changed the commit identity of three Gitleaks fingerprints while retaining the manifest's inline path-to-digest map. This fix removes the content-level trigger: `sourceSha256` and `evidenceSha256` now contain rows with separate `path` and `sha256` fields, marked `path-sha256-v2`.

All 62 original bindings are preserved: 31 source digests verified at the recorded source commit, and 31 evidence digests verified against the kept bytes. The provenance fields are unchanged. No tracked digest covers this manifest itself, so no dependent digest changes were needed.

Pinned Gitleaks 8.24.3 results:

- Standalone old content: three `generic-api-key` findings; converted content: zero, independent of a commit fingerprint.
- Alpha c8404fcd to the fix commit: zero findings.
- Full reachable history and unrestricted local-ref history were both scanned. They report older findings outside this manifest, disclosed separately to the maintainer; those scans are not claimed green. No matched values are reproduced here.

The three exact c8404fcd historical fingerprints are added; the original 22718dc5 fingerprints remain. There is no path wildcard, broader rule exception or credential in these six digest findings. The new content no longer needs its own fingerprint and therefore survives a new squash identity.

Runtime code, UI, screenshots and the original file bindings are unchanged. No runtime/browser campaign is repeated for this metadata-only repair. Restoring the old layout would restore the false-positive trigger; no runtime migration is involved.
