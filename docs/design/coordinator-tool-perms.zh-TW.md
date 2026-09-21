# #804 把 orchestration 收回 coordinator：查證與分階段計畫

狀態：**查證 + 設計，尚未實作。** 針對回報的真問題——codex worker 自己創 instance 當 subagent。

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

## 2. 設計：一份權威，兩個面都吃它

### 2.1 單一來源

```ts
// src/tool-permissions.ts（新）
export type ToolSetName = "full" | "standard" | "worker" | "minimal" | "general";
export function resolveToolSet(config: InstanceConfig, name: string): ToolSetName;
export function toolsFor(profile: ToolSetName): ReadonlySet<string>;
export function mayUseTool(profile: ToolSetName, tool: string): boolean;
```

- **MCP 面**：daemon 依 `resolveToolSet()` 設 `AGEND_TOOL_SET`；mcp-server 依 `toolsFor()` 過濾 —— 跟今天一樣，只是名單來自同一張表。**這一面是「不揭露」**：工具根本不出現在 schema 裡。
- **CLI 面**：`dispatchAgentOperation()` 在 token 驗過之後、執行之前，多問一句 `mayUseTool(profile, tool)`，不通過就回 403 與一句人話。**這一面是「拒絕執行」**：CLI 是個薄客戶端，它想送什麼 op 都行，所以擋必須在伺服端。

兩面的語意刻意不同，但**名單同一份**，所以不會漂移。

### 2.2 為什麼 CLI 面不能只靠「不揭露」

`agent-cli` 是使用者主機上的一支程式，agent 可以直接 `curl` 那個 port。少印一個 op 名字不是控制。**伺服端授權是 CLI 面唯一真正的閘門**，這也是為什麼它該跟 MCP 面用同一份名單、而不是自己維護一份。

### 2.3 OP_MAP 以外的 op 要補進來

`schedule-*` / `decision-*` / `task` / `usage` / `rename` / `set-description` 要各自映到工具名（`create_schedule`、`update_decision`、`task`、`get_usage`、`set_display_name`、`set_description`），否則授權表會有六個洞。這是實作時最容易漏的一塊。

---

## 3. 移／留清單

### 3.1 移出 worker（coordinator-only）

| 工具 | 為什麼 |
|---|---|
| `create_instance` | **本 issue 的直接原因**。worker 需要更多算力時該回報、由 coordinator 決定，不是自己生一個。 |
| `delete_instance`、`replace_instance` | 破壞性，且影響別人的 agent。 |
| `stop_instance`、`pause_instance` | 可以讓別的 worker 靜音。 |
| `start_instance`、`restart_instance`、`wake_instance` | 拉起／重啟別人。general 留著（它的工作就是調度產能）。 |
| `deploy_template`、`teardown_deployment` | 整批建置與拆除。 |
| `create_team`、`delete_team`、`update_team` | 改的是 fleet 的結構。 |
| `update_fleet_defaults`、`update_instance_config` | 寫 fleet.yaml，影響所有人（credential_profile 就在這裡）。 |
| `delegate_task` | 定義上就是 coordinator 動詞：worker 指派 worker 會繞過調度。 |
| `update_decision` | 改別人寫下的共同決策；`post_decision` 留著（新增自己的觀察）。 |

### 3.2 留給 worker

| 工具 | 為什麼 |
|---|---|
| `send_to_instance`、`report_result`、`request_information`、`broadcast` | **peer messaging，協定的核心**。少了 `report_result` 就沒有 worker 這個角色（§1.3）。 |
| `reply`、`react`、`edit_message`、`download_attachment` | 跟人對話。 |
| `list_instances`、`describe_instance`、`list_teams`、`list_models`、`get_fleet_status`、`get_fleet_config`、`get_usage`、`get_effort`、`get_instance_logs`、`list_decisions`、`validate_config` | **唯讀**。知道自己在哪、誰在旁邊。 |
| `task` | 自己的任務板。 |
| `post_decision` | 新增，不修改。 |
| `set_display_name`、`set_description` | 只改自己。 |

### 3.3 三個我不自己拍（見 §7）

`checkout_repo` / `release_repo`、`create_schedule` / `update_schedule` / `delete_schedule`、以及 `post_decision` 要不要也收。

---

## 4. General／coordinator 怎麼判

現況是對的，不用改判定邏輯，只要確認它涵蓋所有情況：

- `isGeneralInstance(config, name)` = `name === "general" || config.instances[name].general_topic === true`（`src/general-instance.ts:11`）。
- `tool_set` 的 validator（`config-validator.ts:52`）只接受 `full|standard|minimal` —— **`general` 手設會 fail validation**，只能由 `general_topic` 內部指派。這條要保留，而且新的 `worker` 應該可以手設（它是一個合理的選擇），`general` 仍然不行。
- **一個不一致要修**：daemon 判的是 `this.config.general_topic`，`isGeneralInstance` 還接受「名字就叫 general」。一個名為 `general` 但沒有 `general_topic: true` 的 instance，在 daemon 眼中是 worker、在別處是 general。收斂成同一個判定。
- classic／一般 instance 沒有 `general_topic`，自然落在 worker。

---

## 5. 相容與遷移

**這是一個會讓既有 fleet 的 worker 少掉工具的改動**，不能無聲。

1. **`full` 留著，可以手設。** 任何真的需要完整工具面的 instance，在 fleet.yaml 寫 `tool_set: full` 就回到今天的行為。這是逃生閥，而且是顯式的。
2. **預設改成 `worker`**（非 general 且未指定時）。這一步才是真正修好 #804 的動作。
3. **被擋下時的回應要能自我解釋**：不是 "unknown tool"，而是「這個 instance 是 worker，`create_instance` 是 coordinator 的工具；請 `report_result` 說明你需要什麼，或由管理者設 `tool_set: full`」。**被擋住的 agent 會把錯誤訊息當指示讀**，所以那句話就是遷移文件。
4. **先觀察再收**（見 stage 拆分）：S1 只記錄「worker 呼叫了 coordinator 工具」，不擋。跑一輪真實 fleet，看看有沒有我們沒想到的合法用途，再切預設。

---

## 6. Stage 拆分

### S1 — 單一來源 + 觀察（不改變任何 instance 能做什麼）
新增 `src/tool-permissions.ts`，把 `TOOL_SETS` 移進去並加上 `worker`；MCP 面改讀它（名單不變）；**CLI 面加上授權檢查但只記錄、不拒絕**；補齊 OP_MAP 以外六個 op 的工具名映射。
驗收：任何 instance 的有效工具集**與今天逐一相同**（對照測試）；CLI 面對每個 op 都算得出工具名（沒有洞）；worker 呼叫 coordinator 工具會留下一筆可查的記錄。

### S2 — CLI 面真的擋
把 S1 的記錄改成 403 + 那句自我解釋的訊息。**此時預設仍是 `full`**，所以只有已經手設 `standard`/`minimal` 的 instance 會有行為改變——而它們本來就以為自己被限制了。
驗收：`tool_set: minimal` 的 CLI-mode instance `spawn` 被拒；MCP-mode 同一個 instance 兩面答案一致；mutation：拿掉檢查要紅。

### S3 — 預設換成 `worker`
非 general 且未指定 → `worker`。`full` 仍可手設。
驗收：新 instance 預設沒有 `create_instance`（**MCP 與 CLI 兩面各一條**）；`report_result`／`request_information` 在 worker 上可用（§1.3 的洞補上）；general 不受影響；明寫 `tool_set: full` 回到舊行為。

### S4 — 文件與 skill
`docs/configuration.md` 的 tool_set 一節、General skill、CHANGELOG 的 Upgrade Notes（這是行為改變）。

---

## 7. 要裁的取捨

**T1 — `checkout_repo` / `release_repo` 算 worker 還是 coordinator？**
它是 repo 租約：worker 要在某個 repo 上工作，直覺上需要它。但它也會影響別的 instance 能不能拿到同一個 repo。今天它**兩個 profile 都不在**（只有 `full`），所以沒有現成答案。我傾向**留給 worker**（它是工作本身的一部分，不是調度），但這會擴大 worker 的面。

**T2 — schedule 三件套？**
`create_schedule` / `update_schedule` / `delete_schedule` 今天在 `general`、不在 `standard`。worker 幫自己排一個定時檢查是合理的；但「worker 可以生出會自己醒來的東西」跟 `create_instance` 是同一類擔憂的弱化版。我傾向**不給 worker**，需要就請 coordinator 排。

**T3 — 預設要不要真的換？**
S3 是唯一真正修好 #804 的一步，也是唯一會讓既有 fleet 行為改變的一步。若要更保守，可以停在 S2 並要求所有 worker 顯式設 `tool_set: worker`——但那代表**沒設的還是 `full`，#804 對新 fleet 依然存在**。我建議照 S3 做，`full` 當逃生閥。

**T4 — S1 的觀察期要多久？**
我建議至少一輪真實 fleet 使用（leader 說了算）。觀察期的價值是抓出我們沒想到的合法用途，成本是 #804 多存在幾天。

---

## 8. 這份設計沒有回答的

- **既有 fleet 裡有多少 worker 正在用被移走的工具**——我沒有掃過 `~/.agend` 的 eventLog／instance 記錄來統計。S1 的觀察期就是為了拿到這個數字，而不是用猜的。
- 本文只涵蓋 AgEnD 自己的工具面。backend CLI 自己的能力（codex 能不能自己 spawn 別的 codex）不在這裡，也不是 `tool_set` 管得到的。
