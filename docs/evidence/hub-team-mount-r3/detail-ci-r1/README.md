# Detail permission fixture correction

CI43542227947 caught an old fixture assumption after the reviewed C6c03c4f2 detail restriction. An ordinary member correctly receives403; the test expected a Team object and read its id. This was a stale integration assertion, not a changed response shape. The corrected case checks admin and current-lead reads, plus403/no detail for ordinary member and outsider. The summary list remains available as before.

The exact case fails first locally (1 failed/5 skipped). After correction, the affected file passes6/6. Commands, source hashes and logs are recorded here. Product source and the factory test are unchanged; no browser, typecheck or mutation campaign is repeated. Existing44 actual journey checks and nine PM views keep their original scope. Fresh exact CI and the alpha.4 release hold remain.
