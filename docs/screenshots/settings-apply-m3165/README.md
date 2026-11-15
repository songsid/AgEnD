M-3165: Settings → Access & security, after a public-link save (config-history 338→339: only `web.public_link.*` and `web.session.public_link`).

`before.zh-TW-dark.png` is the bug: 「變更已套用」 listed ~22 unchanged other-team agents as 「重新啟動此 Agent」.

Cause: `planConfigApply` treated a missing daemon as restart. Fix: compare with `classifyInstanceChange`; a genuine instance-block change is still listed (`tests/settings-apply-job.test.ts`).
