// M-2446: the agent dialog's Codex speed words, lazy and fixed. A tab opened before an upgrade may keep the old
// settings-strings module while the dialog module is fresh: these words live here, registered with the dialog.
import { register } from "/assets/app-i18n.js";
register("settings", {
  en: {
    codexSpeed: "Speed",
    codexSpeedDefault: "Codex default",
    codexSpeedStandard: "Standard",
    codexSpeedFast: "Fast",
    codexSpeedHint: "Fast: uses plan limits at 2.5× (OpenAI). Only for models that offer Fast; otherwise the agent starts without it and the log says why. Changing it restarts the agent.",
  },
  "zh-TW": {
    codexSpeed: "速度",
    codexSpeedDefault: "Codex 預設",
    codexSpeedStandard: "標準",
    codexSpeedFast: "快速",
    codexSpeedHint: "快速：方案額度以 2.5 倍消耗（OpenAI）。只適用於提供 Fast 的模型；不支援時 Agent 會照常啟動，並在記錄中說明原因。變更後會重新啟動 Agent。",
  },
});
