# Combined campaign attempts

The first attempt at aae7b873add4eb10f63b675bf67d484af6b46ad2 built production source successfully, with a peak container memory of 1,885,237,248 bytes and no OOM. Protocol startup then failed because Vitest's default bundled config loader wrote a temporary file under the deliberately read-only node_modules mount. No browser or Fleet/capacity wave ran. The owned CID and image tag were cleaned up; the private full receipt and host samples remain under .artifacts/hub-enrolment-code-campaign/5fc785db-8a72-4fe8-b3ef-49fe257d16c2/.

The next kit revision uses Vitest's runner config loader, which evaluates the same repository config in memory. It keeps read-only modules, unchanged process guards/assertions/timeouts and disabled result cache. Product bytes are unchanged. A new exact-source attempt is required; this is not a passing runtime result.
