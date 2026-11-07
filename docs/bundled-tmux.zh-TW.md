# AgEnD 自己的 tmux

[English](bundled-tmux.md)

AgEnD 讓每個代理在一個 tmux 視窗裡執行。從這個版本起，AgEnD 自帶 tmux，並在自己的 socket 上執行，不再使用主機上安裝的 `tmux`。（設計文件：[docs/design/bundled-tmux.md](design/bundled-tmux.md)。）

## 對你有什麼改變

- **`tmux attach` 不會再看到代理。** 主機的 `tmux` 連的是它自己的預設伺服器，AgEnD 的伺服器不是那一台。請改用：
  - `agend attach [名稱]` 查看某個代理的視窗；
  - `agend tmux <參數…>` 在 AgEnD 的伺服器上執行其他 tmux 指令，例如 `agend tmux ls`、`agend tmux capture-pane -p -t agend:<名稱>`。
- **你的 `~/.tmux.conf` 不再套用到 AgEnD 的伺服器。** AgEnD 只讀自己的 `~/.agend/tmux/agend-tmux.conf`，所以你的按鍵綁定和外掛不會影響訊息送到代理的方式。
- **這個版本第一次啟動時，會在 General（或儀表板的「通知」）貼一則通知**，說明同樣的事。
- `agend doctor` 會顯示 AgEnD 用的是哪個 tmux、在哪個 socket。

## tmux 從哪裡來

tmux 是四個 npm 套件之一：`@songsid/agend-tmux-<os>-<cpu>`（Linux 與 macOS，x64 與 arm64）。它們是 `@songsid/agend` 的選用相依套件，和內建的 Node 一樣從你的 npm registry 安裝。每個套件的 tmux 都由固定版本、核對過檢查碼的原始碼建置，建置結果可重現。安裝 AgEnD 時，會先執行一次這個 tmux（版本、檢查碼、在一次性 socket 上啟動再停止），通過才接受這次安裝。檢查失敗時，npm 會保留你原本的版本。

套件裡的 tmux 會複製到 `~/.agend/tmux/<版本>-<雜湊>/`，伺服器從這份複本執行，所以更新不會在伺服器執行中替換掉它的執行檔。

**不會退回使用主機的 tmux。** 如果這個平台沒有對應套件，或安裝時略過了它（`npm install --omit=optional`，或 registry 鏡像沒有它），AgEnD 會拒絕啟動並說明原因。要在這種主機上仍然執行，請把 `AGEND_TMUX_BIN` 設成 tmux 3.6a 或更新版本的絕對路徑。

**離線主機。** 在可連網的電腦上執行 `npm pack @songsid/agend @songsid/agend-tmux-<平台> @songsid/agend-node-<平台>`，再到離線主機上執行 `npm install -g ./*.tgz`。

## 從舊版升級

不需要做任何事。新版第一次啟動時，會在主機 tmux 的預設伺服器上找到代理的舊視窗，先保存每段對話再關掉它們，然後在自己的伺服器上啟動每個代理。

- 無法證明屬於該代理的舊視窗會保持原樣，只有那個代理會等待。Needs-you 會列出它：關掉那個視窗，或執行 `agend tmux-migrate --release <名稱>`，表示你會自己處理。
- AgEnD 絕不停止主機 tmux 的預設伺服器，因為上面可能有你自己的工作階段。
- 主機的 tmux 會保留。AgEnD 不再使用它，但退回舊版時需要它。

## 退回舊版

請用 `agend rollback <版本>`，例如 `agend rollback 2.3.4`。它會停止艦隊、關閉 AgEnD 自己的 tmux 伺服器、確認伺服器已結束，之後才安裝舊版並啟動。如果無法確認已關閉，它會在安裝任何東西之前停下，並說明還有什麼在執行。

直接執行 `npm install -g @songsid/agend@<舊版>` 會跳過這些步驟。

- **使用 systemd 的 Linux（以及 WSL）：** 仍然安全，服務重新啟動時會結束 AgEnD 的伺服器。
- **macOS，或在前景啟動的艦隊：** AgEnD 的伺服器可能繼續執行，而舊版看不到它，它的代理就會同時執行兩份。這種做法不受支援。較新的 2.3.x 在那台伺服器還有回應時會拒絕啟動代理，並引導你使用 `agend rollback`。
