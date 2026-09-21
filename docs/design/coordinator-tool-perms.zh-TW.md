# #804 把 orchestration 收回 coordinator：查證與分階段計畫

狀態：**查證 + 設計 + 一個月真實用量掃描，尚未實作。** 針對回報的真問題——codex worker 自己創 instance 當 subagent。

裁示已折入（§2.4 的 `coordinator` profile、§3 的 `delegate_task`、§5 的遷移、§6 的 stage）。掃描數據在 §2，**它推翻了第一版移／留清單裡最大的一項**。

**先講結論：這不是 prompt 沒勸住，是我們把能力發給它了。** 而且有兩個獨立的發放管道，**收窄其中一個不會關掉另一個**。

---

## 1. 現況盤點

### 1.1 四個 profile 的實際內容

`src/channel/mcp-tools.ts:144` 的 `TOOL_SETS`。`*` 是 orchestration／lifecycle 動詞：

| | full | standard | minimal | general |
|---|---|---|---|---|
| 工具數 | **47** | 18 | 4 | 26 |
| `* create_instance` | ✓ | · | · | ✓ |
| `* delete_instance` / `replace_instance` | ✓ | · | · | · |
| `* start/stop/pause/wake/restart_instance` | ✓ | · | · | 只有 start/wake/restart |
| `* deploy_template` / `teardown_deployment` | ✓ | · | · | · |
| `* create/delete/update_team` | ✓ | · | · | · |
| `* update_fleet_defaults` / `update_instance_config` | ✓ | · | · | · |
| `* checkout_repo` / `release_repo` | ✓ | · | · | · |
| `* delegate_task` | ✓ | · | · | ✓ |
| `* report_result` / `request_information` | ✓ | **·** | · | ✓ |
| `send_to_instance` / `broadcast` | ✓ | ✓ | 只有 send | ✓ |
| reply / react / edit_message | ✓ | ✓ | 只有 reply | ✓ |

### 1.2 第一個根因：worker 的預設是 `full`

`src/daemon.ts:5797`：

```ts
const defaultToolSet = this.config.general_topic ? "general" : undefined;
const toolSet = this.config.tool_set ?? defaultToolSet;
if (toolSet) mcpEnv.AGEND_TOOL_SET = toolSet;
```

`undefined` 代表**不設 `AGEND_TOOL_SET`**，而 `mcp-server.ts:255` 對「沒設」的處理是 `activeTools = TOOLS`（全部 47 個）。

所以：**任何沒有手動指定 `tool_set` 的 worker，都拿到包含 `create_instance`、`delete_instance`、`deploy_template`、`update_fleet_defaults` 的完整工具面。** codex 不是繞過了什麼，它是用我們發給它的東西。

### 1.3 第二個根因：`standard` 根本不能當 worker 用

這是為什麼大家都留在 `full`，不是因為懶。`standard` **沒有 `report_result`、沒有 `request_information`**——而 fleet 協定要求 worker 做的第一件事就是 `delegate_task` → 工作 → **`report_result`**。

一個被指派任務的 worker 在 `standard` 上**回報不了**。於是唯一「能正常工作」的選擇就是 `full`，而 `full` 附帶整套 orchestration。**現狀不是設定失誤，是可選項裡沒有正確答案。**

### 1.4 第三個根因（最嚴重）：CLI 面完全沒有這層

`src/agent-endpoint.ts` 是 `agent_mode: cli` 的 instance（antigravity 等）用的 HTTP 介面。

```
$ grep -n "TOOL_SETS\|tool_set\|AGEND_TOOL_SET" src/agent-endpoint.ts src/agent-cli.ts
(沒有任何一筆)
```

它有一份**寫死的 `OP_MAP`**（`agent-endpoint.ts:44`），裡面就有：

```ts
spawn: "create_instance",
delete: "delete_instance",
replace: "replace_instance",
deploy:  "deploy_template",
```

`dispatchAgentOperation()` 會驗 `X-Agend-Instance-Token`——**確認你是哪個 instance**——然後就直接執行。**它從來沒問過「這個 instance 可以做這件事嗎」。這是有認證、沒有授權。**

後果：**把 MCP profile 收窄，對 CLI-mode 的 instance 完全沒有效果。** 一個 `tool_set: minimal` 的 CLI-mode worker，今天仍然可以 `agend-agent spawn` 創 instance。

另外，`schedule-*`、`decision-*`、`task`、`usage`、`rename`、`set-description` 這幾個 op **連 `OP_MAP` 都不經過**，是在 dispatch 開頭就直接分流處理的——所以它們不只沒授權，連「有沒有對應的工具名」都還沒定義。設計要一併處理。

---

## 2. 一個月的真實用量，以及它推翻了什麼

`~/.agend/events.db` 的 `activity` 表，**7253 筆 tool_call，2026-08-22 → 2026-09-21**。fleet.yaml 有 53 個 instance，其中 `general_topic` 只有 2 個。

### 2.1 🔴 `delegate_task`：574 次，**572 次來自「非 general」**

```
delegate_task   574 total    general 2    非-general 572    橫跨 20 個 instance
  doupo-leader:327  agend-leader:101  classic-鬥破企劃:22  rd1-a89-dev:23
  classic-鬥破串接:18  doupo-server-codex:13  m365:12  …
```

原因是**這個 fleet 有 coordinator，而 config 表達不了它**。`agend-leader`、`doupo-leader` 是實質的 Tech Lead，但它們身上沒有任何欄位這樣說——只有 `description` 裡的一句人話。`teams` 只有 `members`，**沒有 leader 欄位**。

所以第一版那條「`general_topic` 是 coordinator，其餘皆 worker」**是錯的模型**，照它做會讓這個 fleet 裡每一個 team leader 失去派工能力。

### 2.2 修正：`delegate_task` 留給 worker

#804 的實際傷害是「**創 instance** 當 subagent」。`delegate_task` **不創造也不破壞任何東西**，指派對象必須是已經存在的 instance——它跟 `send_to_instance` 同類，不跟 `create_instance` 同類。第一版把它歸成 coordinator 動詞是從語意推的；數據說它是這個 fleet 第 5 常用的工具。

**移回 worker，遷移面從 20 個 instance 掉到 4 個。**

### 2.3 拿掉 delegate_task 之後的全部實況

一個月 **31 次**，來自 **3 個 leader + fable + 1 個 classic**：

| 工具 | 非-general 次數 | 誰 |
|---|---|---|
| `wake_instance` | 13 | doupo-leader 7、agend-leader 3、classic-鬥破企劃 3 |
| `restart_instance` | 8 | doupo-leader 6、agend-leader 2 |
| `start_instance` | 5 | agend-leader 3、fable 1、doupo-leader 1 |
| `delete_instance` | 2 | agend-leader 1、doupo-leader 1 |
| `create_instance` | **1** | doupo-leader |
| `replace_instance` | 1 | doupo-leader |
| `update_instance_config` | 1 | agend-leader |

**整個月零使用的被移工具有 12 個**：create/update/delete_schedule、create/delete/update_team（`update_team` 的 8 次全是 general）、deploy_template、teardown_deployment、list_deployments、pause_instance、stop_instance、update_decision。這些沒有遷移成本。

`create_instance` 全期 16 次、15 次是 general。**codex 亂創那件事沒有出現在這份資料裡**——可能在視窗外，也可能沒被記錄（§2.5）。

### 2.4 這份表格描述的不是兩層，是三層

上面那 31 次全部是 coordinator 在做 coordinator 的事。它們不該被剝掉，也不該讓每個 worker 都有。所以 profile 變成三層：

| tier | 怎麼取得 | 內容 |
|---|---|---|
| `worker` | **預設**（非 general 且未指定） | 溝通 + 唯讀 + 自己的東西 |
| `coordinator` | **手設** `tool_set: coordinator` | worker ∪ orchestration／lifecycle |
| `general` | 內部指派（`general_topic`），**手設仍然 fail validation** | coordinator 的調度子集 + channel I/O |

比替 `teams` 加 `leader:` 欄位輕，而且貼合實況：真 coordinator 就那幾個，標起來即可。

### 2.5 🔴 這份數據看不到 CLI 面——盲點正好在授權洞上

`logActivity("tool_call", …)` 在 `fleet-manager.ts:5322`，也就是 **MCP 路徑上**。`agent-endpoint.ts` 是**直接 `outboundHandlers.get(tool)`**，完全不經過那一行。

**所以我們對 CLI 面的工具使用一無所知——而那正是唯一沒有授權的那一面。**

這次的掃描仍然是全覆蓋，因為這個 fleet `defaults.agent_mode: mcp` 且沒有任何 instance 覆寫，**零個 cli-mode instance**。但這件事有兩個推論：

1. **S1 的 CLI log-only 不只是觀察期，它是在補一個永久的遙測盲點。**
2. **CLI 面非收窄不可**——我們連它在做什麼都看不見，不能拿「應該沒人這樣用」當安全論證。

---

## 3. 設計：一份權威，兩個面都吃它

### 3.1 單一來源

```ts
// src/tool-permissions.ts（新）
export type ToolSetName = "full" | "standard" | "worker" | "coordinator" | "minimal" | "general";
export function resolveToolSet(config: InstanceConfig, name: string): ToolSetName;
export function toolsFor(profile: ToolSetName): ReadonlySet<string>;
export function mayUseTool(profile: ToolSetName, tool: string): boolean;
```

- **MCP 面**：daemon 依 `resolveToolSet()` 設 `AGEND_TOOL_SET`；mcp-server 依 `toolsFor()` 過濾 —— 跟今天一樣，只是名單來自同一張表。**這一面是「不揭露」**：工具根本不出現在 schema 裡。
- **CLI 面**：`dispatchAgentOperation()` 在 token 驗過之後、執行之前，多問一句 `mayUseTool(profile, tool)`，不通過就回 403 與一句人話。**這一面是「拒絕執行」**：CLI 是個薄客戶端，它想送什麼 op 都行，所以擋必須在伺服端。

兩面的語意刻意不同，但**名單同一份**，所以不會漂移。

### 3.2 為什麼 CLI 面不能只靠「不揭露」

`agent-cli` 是使用者主機上的一支程式，agent 可以直接 `curl` 那個 port。少印一個 op 名字不是控制。**伺服端授權是 CLI 面唯一真正的閘門**，這也是為什麼它該跟 MCP 面用同一份名單、而不是自己維護一份。

### 3.3 OP_MAP 以外的 op 要補進來

`schedule-*` / `decision-*` / `task` / `usage` / `rename` / `set-description` 要各自映到工具名（`create_schedule`、`update_decision`、`task`、`get_usage`、`set_display_name`、`set_description`），否則授權表會有六個洞。這是實作時最容易漏的一塊。

---

## 4. 移／留清單

### 4.1 移出 worker（`coordinator` 與 `general` 才有）

| 工具 | 為什麼 |
|---|---|
| `create_instance` | **本 issue 的直接原因**。worker 需要更多算力時該回報、由 coordinator 決定，不是自己生一個。 |
| `delete_instance`、`replace_instance` | 破壞性，且影響別人的 agent。 |
| `stop_instance`、`pause_instance` | 可以讓別的 worker 靜音。 |
| `start_instance`、`restart_instance`、`wake_instance` | 拉起／重啟別人。general 留著（它的工作就是調度產能）。 |
| `deploy_template`、`teardown_deployment` | 整批建置與拆除。 |
| `create_team`、`delete_team`、`update_team` | 改的是 fleet 的結構。 |
| `update_fleet_defaults`、`update_instance_config` | 寫 fleet.yaml，影響所有人（credential_profile 就在這裡）。 |
| `update_decision` | 改別人寫下的共同決策；`post_decision` 留著（新增自己的觀察）。 |
| `create_schedule`、`update_schedule`、`delete_schedule` | 裁定：不給 worker。「worker 可以生出會自己醒來的東西」是 `create_instance` 的弱化版。整個月零使用。 |

### 4.2 留給 worker

| 工具 | 為什麼 |
|---|---|
| `send_to_instance`、`report_result`、`request_information`、`broadcast` | **peer messaging，協定的核心**。少了 `report_result` 就沒有 worker 這個角色（§1.3）。 |
| `delegate_task` | **裁定留下**（§2.2）。不創不破、對象必須已存在，是帶 correlation id 的 peer messaging。一個月 572 次來自非-general。 |
| `checkout_repo`、`release_repo` | 裁定留下：那是工作本身（掛上 repo 讀檔），不是調度。 |
| `reply`、`react`、`edit_message`、`download_attachment` | 跟人對話。 |
| `list_instances`、`describe_instance`、`list_teams`、`list_models`、`get_fleet_status`、`get_fleet_config`、`get_usage`、`get_effort`、`get_instance_logs`、`list_decisions`、`validate_config` | **唯讀**。知道自己在哪、誰在旁邊。 |
| `task` | 自己的任務板。 |
| `post_decision` | 新增，不修改。 |
| `set_display_name`、`set_description` | 只改自己。 |

### 4.3 已裁定的三項

- `checkout_repo` / `release_repo` → **留給 worker**（工作本身，不是調度；風險低）。
- schedule 三件套 → **coordinator-only**。
- `post_decision` → 留給 worker（新增自己的觀察）；`update_decision` 移走（改別人的）。

---

## 5. General／coordinator 怎麼判

現況是對的，不用改判定邏輯，只要確認它涵蓋所有情況：

- `isGeneralInstance(config, name)` = `name === "general" || config.instances[name].general_topic === true`（`src/general-instance.ts:11`）。
- `tool_set` 的 validator（`config-validator.ts:52`）只接受 `full|standard|minimal` —— **`general` 手設會 fail validation**，只能由 `general_topic` 內部指派。這條要保留，而且新的 `worker` 應該可以手設（它是一個合理的選擇），`general` 仍然不行。
- **一個不一致要修**：daemon 判的是 `this.config.general_topic`，`isGeneralInstance` 還接受「名字就叫 general」。一個名為 `general` 但沒有 `general_topic: true` 的 instance，在 daemon 眼中是 worker、在別處是 general。收斂成同一個判定。
- classic／一般 instance 沒有 `general_topic`，自然落在 worker。

---

## 6. 相容與遷移

**這是一個會讓既有 fleet 的 worker 少掉工具的改動**，不能無聲。

1. **`full` 留著，可以手設。** 任何真的需要完整工具面的 instance，在 fleet.yaml 寫 `tool_set: full` 就回到今天的行為。這是逃生閥，而且是顯式的。
2. **真 coordinator 先標起來**（`tool_set: coordinator`）。依 §2.3，這個 fleet 需要標的是 `agend-leader`、`doupo-leader`、`claude-fable`、以及 `classic-鬥破企劃` 那類 classic 頻道——**四到五個，不是五十三個**。這一步必須在切預設之前做完。
3. **預設改成 `worker`**（非 general 且未指定時）。這一步才是真正修好 #804 的動作。

### 6.1 🔴 換「程式碼預設」對既有 fleet 沒有效果

這個 fleet 的 `fleet.yaml` 裡**顯式寫著**：

```yaml
defaults:
  tool_set: full
```

config 的 default 會蓋過程式碼的 default，所以 S3 只改程式碼，**對這個 fleet 一點作用都沒有**。#804 會在「已經跑著的 fleet」上原封不動地留著——而那正是回報問題的地方。

**做法：不要靜默改寫使用者的 fleet.yaml。** 那一行是他顯式選的，替他改掉會是個意外，而且是寫在他的檔案裡的意外。改成**啟動時發一則 notice**：

> 你的 fleet.yaml 明寫 `defaults.tool_set: full`，所以每個 worker 都拿到全部 47 個工具，包含 `create_instance` 與 `delete_instance`。建議改成 `worker`，並把真正在調度的 instance 個別標成 `coordinator`。

所以 S3 要同時涵蓋兩種 fleet：**新的吃新預設，既有的收到 notice**。兩者都要有測試。
4. **被擋下時的回應要能自我解釋**：不是 "unknown tool"，而是「這個 instance 是 worker，`create_instance` 是 coordinator 的工具；請 `report_result` 說明你需要什麼，或由管理者設 `tool_set: full`」。**被擋住的 agent 會把錯誤訊息當指示讀**，所以那句話就是遷移文件。
5. **先觀察再收**（見 stage 拆分）：S1 只記錄「worker 呼叫了 coordinator 工具」，不擋。跑一輪真實 fleet，看看有沒有我們沒想到的合法用途，再切預設。

---

## 7. Stage 拆分

### S1 — 單一來源 + 觀察（不改變任何 instance 能做什麼）
新增 `src/tool-permissions.ts`，把 `TOOL_SETS` 移進去並加上 `worker` 與 `coordinator`；MCP 面改讀它（名單不變）；**CLI 面加上授權檢查但只記錄、不拒絕**；補齊 OP_MAP 以外六個 op 的工具名映射。

CLI 面的記錄**不只是觀察期的產物**：§2.5 說明了 `agent-endpoint` 從來不寫 `tool_call` activity，所以這是在補一個永久的遙測盲點——今天任何 cli-mode fleet，我們都看不見它在用什麼工具。這一條即使 S2／S3 都完成也該留著。

驗收：任何 instance 的有效工具集**與今天逐一相同**（對照測試）；CLI 面對每個 op 都算得出工具名（沒有洞）；worker 呼叫 coordinator 工具會留下一筆可查的記錄；**CLI 面的呼叫現在也會進 activity**。

觀察窗刻意短：§2 已經用一個月的真實數據回答了「誰在用什麼」，S1 的記錄只是確認 CLI 面沒有 MCP 面看不到的用法。

### S2 — CLI 面真的擋
把 S1 的記錄改成 403 + 那句自我解釋的訊息。**此時預設仍是 `full`**，所以只有已經手設 `standard`/`minimal` 的 instance 會有行為改變——而它們本來就以為自己被限制了。
驗收：`tool_set: minimal` 的 CLI-mode instance `spawn` 被拒；MCP-mode 同一個 instance 兩面答案一致；mutation：拿掉檢查要紅。

### S3 — `coordinator` profile + 預設換成 `worker`
非 general 且未指定 → `worker`；`coordinator` 可手設；`general` 仍然手設會 fail。先標好真 coordinator，再切預設。
驗收：新 instance 預設沒有 `create_instance`（**MCP 與 CLI 兩面各一條**）；`report_result`／`request_information`／`delegate_task` 在 worker 上可用（§1.3 與 §2.2）；`tool_set: coordinator` 拿得到 orchestration；general 不受影響；明寫 `tool_set: full` 回到舊行為；**顯式寫了 `defaults.tool_set: full` 的 fleet 會收到 notice 而不是被改寫**（§6.1）。

### S4 — 文件與 skill
`docs/configuration.md` 的 tool_set 一節、General skill、CHANGELOG 的 Upgrade Notes（這是行為改變）。

---

## 8. 取捨與裁示

**T1 — `checkout_repo` / `release_repo` → 裁定給 worker。** 那是工作本身（掛上 repo 讀檔），不是調度；風險低。

**T2 — schedule 三件套 → 裁定不給 worker。** 「worker 可以生出會自己醒來的東西」是 `create_instance` 的弱化版。整個月零使用，所以沒有遷移成本。

**T3 — 預設換成 `worker` → 裁定換。** 不換的話沒設定的新 fleet 永遠有 #804。`full` 當顯式逃生閥。**但 §6.1 說明了它對既有 fleet 不夠**，所以 S3 必須同時出 notice。

**T4 — 觀察窗 → 裁定用數據取代時間窗。** §2 的一個月真實用量已經回答了「誰在用什麼」，S1 的 log-only 只需短期確認 CLI 面沒有額外用法。

**T5（新）— `delegate_task` → 裁定留給 worker**（§2.2）。這是數據推翻第一版的那一項。

**還沒裁的一項**：真 coordinator 用手設 `tool_set: coordinator` 標記，代表**忘了標就會壞**（那個 instance 靜默失去派工以外的 orchestration）。替代方案是給 `teams` 加 `leader:` 欄位、從結構推導，但那是更大的改動。目前採手設；若日後 coordinator 變多，值得回頭做結構化。

---

## 9. 這份設計沒有回答的

- ~~既有 fleet 裡有多少 worker 正在用被移走的工具~~ —— **已量測，見 §2。** 結果推翻了第一版的移／留清單。
- **CLI 面的用量，任何 fleet**（§2.5）。這不是這次沒做，而是**目前沒有任何資料存在**：`agent-endpoint` 從不寫 activity。S1 補上。
- 本文只涵蓋 AgEnD 自己的工具面。backend CLI 自己的能力（codex 能不能自己 spawn 別的 codex）不在這裡，也不是 `tool_set` 管得到的。
