---
section: Fixed
---
- **啟動 agent 與從儀表板登入不再用同步的 `which` 卡住 fleet（#1490）。** spawn、瀏覽器後端清單與儀表板 `/login` 改走既有的非同步 PATH 探測。spawn 會把探測到的路徑釘進 hint，之後建構 backend 不會再同步查找。二進位不在 PATH 時 spawn 仍只記 log、不拒絕啟動；儀表板登入仍回安裝指令；探測逾時仍視為未安裝。
