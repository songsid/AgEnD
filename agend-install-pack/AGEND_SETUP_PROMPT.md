# AgEnD 安裝引導提示詞（Telegram 艦隊版）

> 請將以下內容完整貼入 Kiro IDE 的 **Vibe 模式**對話框中，AI 會引導你完成安裝。
> 
> ⚠️ 此安裝流程適用於 **macOS / Linux** 環境。AgEnD 不支援 Windows 原生。

---

你是一個耐心的安裝助手。請按照以下步驟引導我在電腦上安裝 AgEnD（Agent Engineering Daemon）。
每個步驟完成後確認結果再繼續下一步。如果任何步驟失敗，幫我診斷問題並提供修復方案。
全程用繁體中文跟我溝通。

## 你需要先知道的事

AgEnD 是一個 AI coding agent 艦隊管理工具，讓你從 Telegram 手機端操控 AI coding 助手。
安裝完成後，你會有一個 Telegram Bot，可以從手機直接跟 AI 對話、指派程式任務。

## 前置條件

- 我已經安裝了 Kiro IDE（並完成 AWS Builder ID 登入）
- 我有一台 macOS 或 Linux 電腦（或 Windows WSL）
- 我有 Telegram 帳號

## 步驟

### 步驟 1：確認基礎環境

先幫我確認以下工具是否可用：

1. **Node.js >= 20**：執行 `node -v` 確認版本
   - 如果不存在或低於 v20：
     ```bash
     curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
     source ~/.nvm/nvm.sh
     nvm install 22
     ```
   - 安裝完確認 `node -v` 顯示 v22+

2. **tmux**：執行 `tmux -V` 確認
   - macOS 缺少的話：`brew install tmux`
   - Linux（Ubuntu/Debian）：`sudo apt-get install -y tmux`
   - Linux（Fedora）：`sudo dnf install -y tmux`

3. **AI 後端 CLI**（至少要有一個）：
   - `kiro-cli --version`（Kiro CLI — 如果你用 Kiro IDE 就裝這個）
   - `claude --version`（Claude Code）
   - 其他：codex / gemini / opencode / agy

   如果只有 Kiro IDE 但沒有 kiro-cli：
   ```bash
   curl -fsSL https://cli.kiro.dev/install | bash
   ```
   安裝後執行 `kiro-cli login` 完成認證（用你的 AWS Builder ID）。

### 步驟 2：安裝 AgEnD

執行一行安裝：

```bash
npm install -g @songsid/agend
```

確認安裝成功：
```bash
agend --version
```

如果 npm 全域安裝需要 sudo：
```bash
sudo npm install -g @songsid/agend
```

### 步驟 3：建立 Telegram Bot 並取得設定值

請一步步引導我完成：

**3a. 建立你的 Telegram Bot：**
1. 打開 Telegram App
2. 在搜尋框輸入 `@BotFather` → 點進去
3. 傳送 `/newbot`
4. 它會問你 Bot 的顯示名稱 → 輸入你想要的名字（例如「小明的 AI 助手」）
5. 它會問你 Bot 的帳號名稱 → 必須以 `bot` 結尾（例如 `xiaoming_ai_bot`）
6. BotFather 會回覆一串 Token，格式像 `1234567890:ABCDefgh...`
7. **複製這串 Token 保存好**

**重要：** 跟 BotFather 說 `/setjoingroups` → 選你的 Bot → `Enable`，讓 Bot 可以加入群組。

請問我拿到的 Bot Token 是什麼？（驗證格式：非空且包含 `:` 字元）

**3b. 建立 Telegram Forum 群組：**
1. 在 Telegram 建立一個新群組（群組名隨你取）
2. 進入群組設定 → 開啟「Topics」功能（讓群組變成 Forum 模式）
3. 把你剛建的 Bot 加入群組 → 設為管理員（給所有權限）
4. 取得群組 ID：
   - 把 `@RawDataBot` 加入群組
   - 它會自動回覆一串 JSON
   - 找到 `"chat": { "id": -100xxxxxxxxxx }` 那個負數就是 Group ID
   - 取得後可把 RawDataBot 踢掉

請問我拿到的 Group ID 是什麼？（驗證格式：以 `-100` 開頭的負數）

**3c. 取得你的 Telegram User ID：**
1. 在 Telegram 搜尋框輸入 `@userinfobot` → 點進去
2. 對它傳送任何一則訊息
3. 它會回覆你的資訊，其中 `Id:` 後面的數字就是你的 User ID

請問我拿到的 User ID 是什麼？

### 步驟 4：執行 AgEnD Quickstart

現在用 AgEnD 的互動設定精靈完成初始化：

```bash
agend quickstart
```

設定精靈會依序問你：
1. **通訊平台** → 選 `Telegram`
2. **Bot Token** → 貼上步驟 3a 的 Token
3. **Group ID** → 貼上步驟 3b 的 Group ID
4. **Allowed User** → 填步驟 3c 的 User ID
5. **Backend** → 選你安裝的 CLI（建議選 `kiro-cli`）
6. **第一個 Instance 名稱** → 取個名字（例如 `my-assistant`）
7. **工作目錄** → 指定一個專案資料夾（或留空用預設）

完成後會產生 `~/.agend/fleet.yaml` 和 `~/.agend/.env`。

### 步驟 5：驗證設定檔

幫我確認設定檔內容正確：

```bash
cat ~/.agend/fleet.yaml
```

應該包含：
- `channel.type: telegram`
- `channel.group_id:` 你的群組 ID
- `channel.access.allowed_users:` 包含你的 User ID
- `instances:` 至少有一個 instance
- `defaults.backend:` 你選的 CLI

```bash
cat ~/.agend/.env
```

應該包含：
- `AGEND_BOT_TOKEN=你的bot_token`

### 步驟 6：啟動 Fleet

```bash
agend fleet start
```

等待幾秒，確認啟動成功：
```bash
agend ls
```

應顯示你的 instance 狀態為 `running` 或 `idle`。

### 步驟 7：驗證連線

1. 打開 Telegram → 進入你的 Forum 群組
2. 你應該會看到 AgEnD 自動建立了一個 Topic（跟你的 instance 同名）
3. 在那個 Topic 裡傳送一則訊息（例如「你好」）
4. Agent 應在幾秒內回覆

如果有回應 → 安裝成功 ✅
如果沒回應 → 執行 `agend logs` 幫我查看錯誤訊息

### 步驟 8：設為系統服務（開機自動啟動）

```bash
agend service install
```

這會自動設定：
- macOS → launchd（開機自動啟動）
- Linux → systemd（開機自動啟動）

確認服務狀態：
```bash
agend service status
```

---

## 完成！

安裝摘要：
- ✅ Node.js 20+ / tmux
- ✅ AgEnD 已安裝
- ✅ AI CLI 後端已認證
- ✅ Telegram Bot 已建立並加入群組
- ✅ Fleet 設定完成
- ✅ Agent 運行中
- ✅ 系統服務已註冊

## 日常使用

- **手機操控**：打開 Telegram → 到群組裡的 Agent Topic → 直接打字或語音
- **開機自啟動**：不用管，電腦開機就會自動啟動
- **查看狀態**：`agend ls`
- **查看日誌**：`agend logs`（或 `agend logs <instance名稱>`）
- **停止服務**：`agend fleet stop`
- **重啟服務**：`agend fleet restart`

## 進階：新增更多 Agent Instance

如果你想讓一個 Bot 同時管理多個專案：

```bash
agend instance create --name "project-b" --dir ~/Projects/my-other-project --backend kiro-cli
```

每個 instance 會自動建立一個新的 Telegram Forum Topic，互不干擾。

## 進階：花費控制

在 `~/.agend/fleet.yaml` 中加入：

```yaml
defaults:
  cost_guard:
    daily_limit_usd: 10
    warn_at_percentage: 80
    timezone: Asia/Taipei
```

超過每日上限會自動暫停，不會爆帳。

## 如有問題

- 在 Kiro IDE 中把錯誤訊息貼到聊天框，AI 會幫你排查
- 查看日誌：`agend logs` 或 `cat ~/.agend/daemon.log`
- AgEnD 文件：https://github.com/songsid/AgEnD
- 找管理員協助
