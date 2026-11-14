# Public observation encoding

Current browser receipt JSON uses evidenceEncoding=public-observations-v1. This is a lossless representation of the captured public observations:

- idempotencyId is the live message DTO's idempotencyKey UUID, a public deduplication ID. Decode the field name back to idempotencyKey.
- An asset-map object is represented as sha256ToPaths: digest to path array. Expand it back to the original path to digest mapping.
- Drop the root evidenceEncoding marker when decoding.

Every changed receipt is deep-equal to its original captured JSON after this decode. Original bytes are available in Git at integration472aac0c6. No PNG, check result, timestamp, ID, public hash, runtime DTO or source is changed. This avoids misleading secret-like evidence labels in current scans; exact historical findings are independently pinned. The C evidence r4-final/receipt-encoding.json binds before/after hashes and transform counts.
