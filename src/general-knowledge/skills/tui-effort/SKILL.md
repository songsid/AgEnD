---
name: tui-effort
description: 在 Kiro CLI TUI instance 中，透過 tmux 查看或設定模型的 reasoning effort
roles: [general]
---

# Kiro TUI Effort

## 適用範圍

已在 Kiro CLI 2.14.2、AgEnD `kiro_ui: tui` 實測。

```yaml
instances:
  my-kiro:
    backend: kiro-cli
    kiro_ui: tui
```

**kiro_ui 模式差異：**
- `kiro_ui: tui`：Kiro v2 TUI（預設推薦）；本 skill 適用。
- `kiro_ui: v3`：v3 unified agent harness；是不同的 agent engine，不只是換皮膚。session 格式與 v2 不相容，不能互 resume。若要使用 v3，需另外實測 `/effort` 行為。
- `kiro_ui: legacy`：舊 UI，互動行為不同，本 skill 不適用。

若修改 `kiro_ui`，先 reload 再 restart：
```bash
agend reload
# 然後用 AgEnD 的 restart_instance 工具重啟 instance
```

## 設定 effort（推薦方式）

直接傳 level 給 `/effort`，不要依賴 picker 游標位置：

```bash
INSTANCE='<instance-name>'
tmux send-keys -t "agend:${INSTANCE}" -l '/effort max'
tmux send-keys -t "agend:${INSTANCE}" Enter
sleep 1
tmux capture-pane -t "agend:${INSTANCE}" -p | tail -5
```

成功回應：
```
Effort set to max
```

等待輸入時，狀態列顯示目前 effort：
```
kiro_default · claude-sonnet-4.6 · Max · ◔ 10% · λ ...
```

**可用 level：** `low`、`medium`、`high`、`xhigh`、`max`
- 實際支援集合由目前 model 決定；不支援的 level 不出現在 picker
- 例：Claude Sonnet 4.6 支援 Low / Medium / High / Max（無 xhigh）

## 使用互動 picker（人工操作 / 除錯）

```bash
INSTANCE='<instance-name>'
tmux send-keys -t "agend:${INSTANCE}" -l '/effort'
tmux send-keys -t "agend:${INSTANCE}" Enter
sleep 1
tmux capture-pane -t "agend:${INSTANCE}" -p | tail -10
```

如需 tmux 自動導航，每個按鍵**分開送**並加短暫間隔：

```bash
tmux send-keys -t "agend:${INSTANCE}" Down; sleep 0.2
tmux send-keys -t "agend:${INSTANCE}" Down; sleep 0.2
tmux send-keys -t "agend:${INSTANCE}" Down; sleep 0.2
tmux send-keys -t "agend:${INSTANCE}" Enter
```

**不要假設固定次數 = 固定 level。** 游標初始在 Low，每次 Down 移一格；支援 `xhigh` 的 model 會多一個選項，所需次數不同。自動化一律用 `/effort <level>`。

## Effort 等級說明

| 等級 | 行為與適用場景 |
|------|--------------|
| Low | 回覆較快、較短；簡單查詢與快速確認 |
| Medium | 速度與推理深度平衡；一般開發任務 |
| High | 更完整的分析；複雜重構與架構決策 |
| XHigh | 延伸推理；多檔案改動（僅部分 model 支援） |
| Max | 最大推理深度；困難 debug、安全審查、高耦合問題 |

Effort 控制模型的 reasoning 深度（thinking tokens），較高 level 通常增加延遲與 credits 消耗。

## 持久化

Kiro CLI 2.6.0 起，`/effort` 設定**自動持久化**到 `~/.kiro/settings/cli.json`，**不需要每次 restart 後重設**。

若要用設定檔指定 per-model 預設：
```json
// ~/.kiro/settings/cli.json 或 .kiro/settings/cli.json
{
  "chat.modelDefaults": {
    "claude-sonnet-4.6": {
      "output_config": {
        "effort": "max"
      }
    }
  }
}
```

優先序：session `/effort` > workspace `chat.modelDefaults` > user `chat.modelDefaults` > model 預設。

**注意：** 不要在 fleet.yaml 加 `model_reasoning_effort`，AgEnD 目前不會將此欄位傳給 kiro-cli。

## 注意事項

- 送指令前確認 instance 正在等待輸入（不在生成中）
- v3 是不同 engine，不要直接套用此 skill 的畫面假設
- 自動化一律用 `/effort <level>`，不要操作 picker
