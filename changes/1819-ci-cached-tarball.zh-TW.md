---
section: Changed
---
- **CI 不再灌高 `@songsid/agend` 的 npm 下載數（#1819）。** 會安裝已發布 2.1.12 的 job（Node 20 rollback smoke、data-downgrade 檢查、runtime-acceptance 的 hop、Mac GUI rehearsal）只抓一次 tarball，存在 Actions cache，每次安裝前都比對 registry 的 `dist.integrity`，不符就讓 job 失敗。如果 npm 仍然抓了我們的 tarball，安裝步驟也會失敗。
