---
section: Fixed
---
- **Windows 安裝程式會分別從 Windows 和 WSL 檢查真正需要的網站，連不上時說明原因（#2650）。** 以前只連一次 Google 就決定裝不裝：擋掉 Google 的網路，即使需要的網站都連得上也會被停下；只有 Windows 瀏覽器透過公司 proxy 連得出去的網路，檢查會通過，之後卻在 WSL 裡失敗。現在 Windows 這邊檢查 AgEnD 的安裝網站（必須）和 GitHub（只警告）。Ubuntu 好了之後，WSL 這邊檢查 AgEnD 的安裝程式、npm、Node.js、nvm（必須），以及 Ubuntu 套件庫和各家 AI 後端的網站（只警告）。每個網站最多試兩次、每次 10 秒，有任何 HTTP 回應就算連得上。連不上時會說出原因（DNS、逾時、連線被拒、HTTPS 憑證不被信任、proxy）和怎麼做：憑證問題就向 IT 拿公司的根憑證裝進 Ubuntu，並設定 `NODE_EXTRA_CA_CERTS`；proxy 問題就讓 WSL 也用 Windows 的 proxy，畫面上只顯示主機和連接埠，不會顯示帳密。必須的網站連不上時，會先問要不要繼續，預設是停下來。一行安裝指令本身的下載現在也有時間上限，並會說出是 proxy、憑證還是逾時的問題。
