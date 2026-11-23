// The words of a task card in the chat — the list that opens when `#` is typed, and a chip's status and tip.
// The status words are the task board's own (Fleet › Tasks: fleet-task-common.js), so a chip and a card say the same.
import { register } from "/assets/app-i18n.js";

register("taskref", {
  en: {
    list: "Task cards",
    pickHint: "Task cards — press Enter or Tab to put one in",
    none: "No task card matches",
    sub: "sub task",
    main: "main task",
    "s.open": "To do", "s.claimed": "In progress", "s.blocked": "Blocked", "s.review": "To confirm", "s.done": "Done", "s.cancelled": "Cancelled",
    open: "Open task card {0}",
  },
  "zh-TW": {
    list: "任務卡片",
    pickHint: "任務卡片 — 按 Enter 或 Tab 插入",
    none: "找不到符合的任務卡片",
    sub: "子任務",
    main: "主任務",
    "s.open": "待辦", "s.claimed": "進行中", "s.blocked": "卡住", "s.review": "待確認", "s.done": "完成", "s.cancelled": "取消",
    open: "開啟任務卡片 {0}",
  },
});
