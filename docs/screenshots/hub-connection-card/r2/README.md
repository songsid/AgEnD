# R2 — classify CSS attributes as technical strings

CI's remaining failure was the wording scanner reading conditional HTML class lists (`form s-company-join`, `card s-company-join`) as user-visible copy. The scanner now excludes interpolated class/className expressions only in an `html` tagged template. It continues to inspect interpolated titles/ARIA copy and ordinary string templates. Two parser controls pin those boundaries; the existing forbidden network wording checks remain unchanged.

The named-link scanner plus mounted card and Settings-search suites pass 96/96. Product source is byte-identical to the source-cleared R1 head. R1's Pause/503/Retry, full layout, owned browser and scope-limit evidence carries; this test-only adjustment adds no product behavior or native/live operation.
