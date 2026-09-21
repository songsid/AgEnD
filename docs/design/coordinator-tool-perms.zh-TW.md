# #804 把 orchestration 收回 coordinator：查證與分階段計畫

狀態：**查證 + 設計 + 一個月真實用量掃描，尚未實作。** 針對回報的真問題——codex worker 自己創 instance 當 subagent。

裁示已折入。掃描數據在 §2，**它推翻了第一版移／留清單裡最大的一項**；fable 的碼審在 §3，**它推翻了第一版的核心前提**——「MCP 面靠不揭露」不是控制。

**先講結論：這不是 prompt 沒勸住，是我們把能力發給它了。** 而且有**四條**獨立的路可以呼叫這些工具，其中三條連工具名單都不看——所以這張票的重點不是「發哪些工具」，而是**在收斂點上拒絕**。

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

## 3. 設計：一份權威，在收斂點上拒絕

### 3.1 🔴 第一版的核心前提是錯的：「不揭露」不是控制

第一版寫「MCP 面是不揭露：工具根本不出現在 schema 裡」。**逐行讀碼之後，那句話不成立。**

```
$ grep -n "activeTools" src/channel/mcp-server.ts
254: let activeTools: typeof TOOLS;
256:   activeTools = TOOLS;
258:   activeTools = TOOLS.filter(...)
261:   activeTools = TOOLS;
264: mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: activeTools }));
```

**只有 ListTools 用到它。** CallTool（`mcp-server.ts:268`）拿 `req.params.name` 就直接 `ipcRequest`，從不比對 `activeTools`。所以一個 `tool_set: minimal` 的 MCP worker，**只要模型猜到 `create_instance` 這個名字就執行得了**。tool_set 今天的全部效果是「少花 token、少一點提示」，不是權限。

### 3.2 四條入口，三個 sink

| # | 入口 | 今天檢查什麼 |
|---|---|---|
| 1 | MCP `tools/list` → 模型看到的清單 | `activeTools`（**唯一用到名單的地方**） |
| 2 | MCP `tools/call` 直接指定名字 | **什麼都不檢查** |
| 3 | **直接寫 `channel.sock`** —— instanceDir 裡 0600 的 unix socket，backend CLI 同使用者有 shell，`{type:"fleet_outbound", tool:"create_instance"}` **連 mcp-server 都不經過** | **什麼都不檢查** |
| 4 | `POST /agent` 帶 `agent.token` —— 而那個 token **每個 instance 每次 spawn 都會寫**（`daemon.ts:6366`），**不限 cli-mode**，所以 MCP-mode 的 instance 也能 curl | 只驗「你是哪個 instance」 |

第 3 條是關鍵：**它讓「MCP 面」與「CLI 面」這個二分法本身失效**。一個 agent 只要能開檔就能送 IPC，中間沒有任何我們控制的層。

四條路匯進**三個伺服端 sink**：

1. `handleOutboundFromInstance()`（`fleet-manager.ts:5325`）—— 路徑 1/2/3 全部到這裡；
2. IPC 的其他分派分支（`fleet-manager.ts:4228` 起）—— schedule／decision／task／display-name／description **各有自己的 handler，都不經過 sink 1**；
3. `dispatchAgentOperation()`（`agent-endpoint.ts:170`）—— 路徑 4。

### 3.3 授權放 sink，不揭露降為 UX

```ts
// src/tool-permissions.ts（新）
export type ToolSetName = "full" | "standard" | "worker" | "coordinator" | "minimal" | "general";
export function resolveToolSet(config: InstanceConfig | undefined, name: string): ToolSetName;
export function toolsFor(profile: ToolSetName): ReadonlySet<string>;
export function mayUseTool(profile: ToolSetName, tool: string): boolean;
```

**三處伺服端拒絕**，全部用同一個 `mayUseTool`：

1. **`handleOutboundFromInstance` 一進來就檢查**，在 `outboundHandlers.get(tool)` 之前。profile 用**socket 擁有者的 `name`** 解——不是 `msg` 裡的 `senderSessionName`，那個是呼叫端自己填的，拿它當身分等於沒檢查。不過就 `respond(null, …)`，**永遠不到 handler**。
2. **IPC 的其他分派分支同樣檢查**（§3.4）。
3. **`dispatchAgentOperation` 在 token 驗過之後、任何分流之前**檢查——包含那六個早分流的 op。

**mcp-server 的 CallTool 也照 `activeTools` 拒**，但它的角色改寫清楚：**那是讓錯誤更早、更好讀，不是安全邊界**。它跟 ListTools 的過濾一樣屬於 UX——真正的閘門在 sink。路徑 3 完全繞過 mcp-server，這就是為什麼它不能是邊界。

### 3.4 IPC 的每一個分支都是一個 sink

`fleet-manager.ts:4228` 起的分派，除了 `fleet_outbound` 之外還有：

```
fleet_schedule_create / list / update / delete   → handleScheduleCrud
fleet_decision_create / list / update            → handleDecisionCrud
fleet_task                                       → handleTaskCrud
fleet_set_display_name / fleet_set_description   → handleSetDisplayName / handleSetDescription
```

**每一組都繞過 `handleOutboundFromInstance`。** fable 點名了 schedule 四個——不補的話「schedule 是 coordinator-only」在 MCP 面直接有洞。**同樣的形狀也在 decision 上**：我們的移出清單裡有 `update_decision`，而它走 `fleet_decision_update`，所以**它有一模一樣的洞**。權限表要覆蓋這整組 IPC type，不能只補 schedule。

### 3.5 OP_MAP 以外的 op 要補進來

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
- **一個不一致要修**：daemon（`daemon.ts:5797`）判的是 `this.config.general_topic`，而 `isGeneralInstance()` 還接受「名字就叫 general」（`fleet-manager.ts:1621`、`1906` 都用它）。一個名為 `general` 但沒有 `general_topic: true` 的 instance，在 daemon 眼中是 worker、在別處是 general。**收斂成同一個呼叫**：daemon 那處改用 `isGeneralInstance`。
- **`resolveToolSet` 的順序有先後**：**先看使用者顯式寫的 `tool_set`（含 `full`），再套 general／worker 的預設**。反過來寫的話，general 就降不了級、worker 也升不了級——顯式設定必須永遠贏過角色推導。
- **🔴 打錯字等於 `full`**（`mcp-server.ts:253-261`）：不認得的 `AGEND_TOOL_SET` 目前印一行錯誤然後 `activeTools = TOOLS`。**把一個 typo 變成最大權限，方向完全反了。** 改成退回 `worker`，或直接拒絕啟動。同樣的原則要套在新的 sink 檢查：解不出 profile 時給最小的那個，不是最大的那個。
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

### 6.2 notice 要點名，不能只是通則

「coordinator 用手設標記」的代價是**忘了標就會靜默壞**——那個 instance 某天想重啟別人，發現不行。通則式的建議（「請把在調度的 instance 標成 coordinator」）把辨識工作丟回給使用者，而**我們手上就有答案**。

notice 要從 `activity` 反推，規則是「**這個 instance 呼叫過新 profile 會拒絕的工具嗎**」——那正好就是「誰會壞」的定義，不是猜測：

```
你的 fleet 有 4 個 instance 用過 worker 拿不到的工具。改預設之前，
把它們標成 tool_set: coordinator：

  doupo-leader-t1503382159321464899   restart×6 wake×7 replace×1 delete×1 create×1 start×1
  agend-leader-t1503382358143799511   restart×2 start×3 wake×3 delete×1 update_instance_config×1
  claude-fable-t1532671461406277715   start×1
  classic-鬥破企劃-7393                wake×3        （已不在 fleet.yaml，classicBot 頻道）
```

（上面是本機 2026-08-22 → 09-21 的實際結果。）

**刻意不點名「只用 delegate_task」的 instance**：`delegate_task` 留在 worker（§2.2），所以 `rd1-a89-dev`（23 次）、`classic-鬥破串接`（18 次）這些**不會壞**，把它們列進來只會讓使用者標一堆不需要標的東西，然後對這則 notice 失去信任。**名單的定義是「會壞的」，不是「看起來像 coordinator 的」。**

一個實作前提：這份反推**只看得到 `handleOutboundFromInstance` 那一條路**（§2.5）。所以 notice 的措辭要留餘地（「用過…的有這些」而不是「只有這些需要標」），而 S1 在三個 sink 都記錄之後，這份名單才會完整。
4. **被擋下時的回應要能自我解釋**：不是 "unknown tool"，而是「這個 instance 是 worker，`create_instance` 是 coordinator 的工具；請 `report_result` 說明你需要什麼，或由管理者設 `tool_set: full`」。**被擋住的 agent 會把錯誤訊息當指示讀**，所以那句話就是遷移文件。
5. **先觀察再收**（見 stage 拆分）：S1 只記錄「worker 呼叫了 coordinator 工具」，不擋。跑一輪真實 fleet，看看有沒有我們沒想到的合法用途，再切預設。

---

## 7. Stage 拆分

### S1 — 單一來源 + 觀察（不改變任何 instance 能做什麼）
新增 `src/tool-permissions.ts`，把 `TOOL_SETS` 移進去並加上 `worker` 與 `coordinator`；MCP 面改讀它（名單不變）；**CLI 面加上授權檢查但只記錄、不拒絕**；補齊 OP_MAP 以外六個 op 的工具名映射。

**記錄要在三個 sink 各記一筆**（sink／instance／profile／tool），不是只在 agent-endpoint。§2 那份掃描只看得到 `handleOutboundFromInstance` 那一條——所以今天的 eventLog **完全看不到 `/agent` 與 schedule／decision IPC 的使用**。只記一處就等於觀察期照樣盲。

這也**不只是觀察期的產物**：§2.5 說明了那是一個永久的遙測盲點，這一條即使 S2／S3 都完成也該留著。

驗收：
- **同一個 `mayUseTool` 被三個 sink 呼叫**——任何一處拿掉，都要有一條測試變紅。
- 任何 instance 的有效工具集**與今天逐一相同**（對照測試），**包含 CLI 面的每個 op 都解得出工具名**。
- 三個 sink 各自都會留下記錄。

觀察窗刻意短：§2 已經用一個月的真實數據回答了「誰在用什麼」，S1 的記錄只是確認 CLI 面沒有 MCP 面看不到的用法。

### S2 — 三個 sink 真的擋
把 S1 的記錄改成拒絕 + 那句自我解釋的訊息。**此時預設仍是 `full`**，所以行為會改變的只有**已經手設 `standard`／`minimal` 的 instance——而且不分 `agent_mode`**（§3.2 說明了那個二分法本來就不成立）。它們本來就以為自己被限制了，現在才真的是。

驗收：
- **`tool_set: minimal` 的 MCP-mode instance 直接對 `channel.sock` 送 `{type:"fleet_outbound", tool:"create_instance"}` 被拒。** 這條最重要：它證明防線不靠「不揭露」，因為這條路徑連 mcp-server 都沒經過。
- 帶合法 `agent.token` 的 `POST /agent` `spawn` 得到 403。
- MCP `tools/call` 直接指定沒被揭露的名字：被拒。
- `fleet_schedule_create` 走 IPC：被拒（§3.4）。
- mutation：任一 sink 的檢查拿掉要紅。

### S3 — `coordinator` profile + 預設換成 `worker`
非 general 且未指定 → `worker`；`coordinator` 可手設；`general` 仍然手設會 fail。先標好真 coordinator，再切預設。
驗收：新 instance 預設沒有 `create_instance`（**MCP 與 CLI 兩面各一條**）；`report_result`／`request_information`／`delegate_task` 在 worker 上可用（§1.3 與 §2.2）；`tool_set: coordinator` 拿得到 orchestration；general 不受影響；明寫 `tool_set: full` 回到舊行為；**顯式寫了 `defaults.tool_set: full` 的 fleet 會收到 notice 而不是被改寫**（§6.1）；**notice 會點名實際用過被拒工具的 instance，而不是只給通則**（§6.2），且**不會點名只用 `delegate_task` 的 instance**（mutation：把 `delegate_task` 算進去要紅——那會讓名單從 4 個變成 20 幾個）。

### S4 — 文件與 skill
`docs/configuration.md` 的 tool_set 一節、General skill、CHANGELOG 的 Upgrade Notes（這是行為改變）。

---

## 8. 取捨與裁示

**T1 — `checkout_repo` / `release_repo` → 裁定給 worker。** 那是工作本身（掛上 repo 讀檔），不是調度；風險低。

**T2 — schedule 三件套 → 裁定不給 worker。** 「worker 可以生出會自己醒來的東西」是 `create_instance` 的弱化版。整個月零使用，所以沒有遷移成本。

**T3 — 預設換成 `worker` → 裁定換。** 不換的話沒設定的新 fleet 永遠有 #804。`full` 當顯式逃生閥。**但 §6.1 說明了它對既有 fleet 不夠**，所以 S3 必須同時出 notice。

**T4 — 觀察窗 → 裁定用數據取代時間窗。** §2 的一個月真實用量已經回答了「誰在用什麼」，S1 的 log-only 只需短期確認 CLI 面沒有額外用法。

**T5（新）— `delegate_task` → 裁定留給 worker**（§2.2）。這是數據推翻第一版的那一項。

**T6 — 手設 coordinator「忘了標就會壞」怎麼辦 → 裁定：讓 notice 點名（§6.2）。** 從 activity 反推「用過 worker 拿不到的工具」的 instance 並列出來，遷移就會自我引導，那個代價被壓掉大半。`teams` 加 `leader:` 欄位的結構化做法留著——**日後 coordinator 變多、或 notice 的名單開始失準時再回頭**。

---

## 9. 記下來、不進這輪

- **`handleScheduleCrud` 的 update／delete 不檢查排程的 source 是不是呼叫者**——任何 instance 刪得掉別人的排程。T2 收掉 worker 那一面，但 `general`／`full` 之間仍然可以互刪。這是所有權檢查，跟 profile 是兩件事。
- **`broadcast` 留在 worker**：它是一個全 fleet 的 prompt-injection 面。S1 的觀察若顯示沒人用，就收掉。
- **`get_fleet_config` 留在 worker**：整份 fleet.yaml 讀得到，包含每個 instance 的 `credential_profile` 名字。唯讀，但是資訊面。

---

## 10. 這份設計沒有回答的

- ~~既有 fleet 裡有多少 worker 正在用被移走的工具~~ —— **已量測，見 §2。** 結果推翻了第一版的移／留清單。
- **CLI 面的用量，任何 fleet**（§2.5）。這不是這次沒做，而是**目前沒有任何資料存在**：`agent-endpoint` 從不寫 activity。S1 補上。
- 本文只涵蓋 AgEnD 自己的工具面。backend CLI 自己的能力（codex 能不能自己 spawn 別的 codex）不在這裡，也不是 `tool_set` 管得到的。
