// Optional admin-only observation. No entries in the chat ledger; no child execution/approval controls.
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
import { ErrorState } from "/assets/ui-states.js";
register("subagents", {
  en: { title: "Subagents", completed: "{0} finished", running: "{0} running", unknown: "{0} unconfirmed", parent: "Main Agent task: {0}", turn: "Main Agent task turn: {0}", done: "Finished", live: "Running", unsure: "Unconfirmed", seconds: "{0} s", elapsed: "{0} s elapsed", note: "A subagent's report is not the main Agent's final answer.", gap: "Some records are missing or no longer current. Their state is unconfirmed.", failed: "Subagent status could not be checked.", fallback: "Subagent", scroll: "Scroll to see all child runs.", bound: "Up to 16 recent child runs are shown." },
  "zh-TW": { title: "子 Agent", completed: "{0} 已完成", running: "{0} 執行中", unknown: "{0} 待確認", parent: "主 Agent 工作：{0}", turn: "主 Agent 工作回合：{0}", done: "已完成", live: "執行中", unsure: "待確認", seconds: "{0} 秒", elapsed: "已經過 {0} 秒", note: "子 Agent 的回報不是主 Agent 的最終答覆。", gap: "部分紀錄缺漏或已不再是目前的紀錄，狀態待確認。", failed: "暫時無法確認子 Agent 的狀態。", fallback: "子 Agent", scroll: "捲動檢視所有子工作回合。", bound: "最多顯示最近 16 個子工作回合。" },
});
const copy = (key, ...args) => t("subagents." + key, ...args);
const uncertain = rows => rows.map(({ summary, durationMs, ...row }) => ({ ...row, state: "unknown" }));
/** One physical fetch at a time; unmount/name changes retire the continuation, not just the timer. */
export function observeSubagents(name, { fetcher = fetch, changed, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let live = true, busy = false, timer = null, abort = null, state = { owner: null, runs: [], error: false };
  const publish = value => { if (live) { state = value; changed(value); } };
  const schedule = () => { if (live) timer = setTimer(read, 6000); };
  async function read() {
    if (!live || busy) return;
    if (timer !== null) { clearTimer(timer); timer = null; }
    busy = true; abort = typeof AbortController === "function" ? new AbortController() : null;
    let denied = false;
    try {
      const res = await fetcher("/ui/subagents?instance=" + encodeURIComponent(name), { credentials: "same-origin", signal: abort?.signal });
      if (!live) return;
      if ([401, 403, 404].includes(res.status)) { denied = true; publish({ owner: null, runs: [], error: false }); return; }
      if (!res.ok) throw Error("unavailable");
      const body = await res.json(); if (!live) return;
      if (body?.subagents !== 1 || !Array.isArray(body.runs) || body.runs.length > 16) throw Error("incompatible");
      if (!body.owner) publish({ owner: null, runs: [], error: false });
      else if (body.status !== "ok") publish({ owner: body.owner, runs: body.owner && body.owner === state.owner ? uncertain(state.runs) : [], error: true });
      else publish({ owner: body.owner, runs: body.runs, error: false });
    } catch { if (live) publish({ ...state, runs: uncertain(state.runs), error: true }); }
    finally { busy = false; abort = null; if (!denied) schedule(); }
  }
  void read();
  return { retry: read, stop() { live = false; if (timer !== null) clearTimer(timer); abort?.abort(); } };
}
function styles() {
  if (document.querySelector('link[href="/assets/subagent-row.css"]')) return;
  const link = document.createElement("link"); link.rel = "stylesheet"; link.href = "/assets/subagent-row.css"; document.head.appendChild(link);
}
export function SubagentRow({ name }) {
  const [value, setValue] = useState({ owner: null, runs: [], error: false }), [tick, setTick] = useState(Date.now());
  const observer = useRef(null);
  useEffect(() => { styles(); setValue({ owner: null, runs: [], error: false }); const o = observeSubagents(name, { changed: setValue }); observer.current = o; return () => { o.stop(); observer.current = null; }; }, [name]);
  useEffect(() => { if (!value.runs.some(r => r.state === "running")) return; const id = setInterval(() => setTick(Date.now()), 1000); return () => clearInterval(id); }, [value]);
  if (!value.runs.length && !value.error) return null;
  const counts = ["completed", "running", "unknown"].map(s => { const n = value.runs.filter(r => r.state === s).length; return n ? copy(s, n) : null; }).filter(Boolean);
  const groups = new Map();
  for (const row of value.runs) { if (!groups.has(row.parentTurn)) groups.set(row.parentTurn, []); groups.get(row.parentTurn).push(row); }
  return html`<details class="subagent-progress" data-trust="subagent-observation"><summary><span>${copy("title")}</span><span class="note">${counts.join(" · ")}</span></summary><p class="note subagent-scroll-hint">${copy("scroll")}</p><div class="subagent-scroll">
    ${value.error ? html`<${ErrorState} message=${copy("failed")} onRetry=${() => observer.current?.retry()} />` : null}
    ${[...groups].map(([turn, rows]) => html`<section key=${turn} class="subagent-group"><p class="note subagent-parent">${rows[0].parentTask ? copy("parent", rows[0].parentTask) : copy("turn", new Date(Math.min(...rows.map(r => r.parentStartedAt))).toLocaleString())}</p>
      ${rows.map(r => html`<article key=${r.key} class="subagent-item"><div class="subagent-head"><strong>${r.name || copy("fallback")}</strong>${r.type ? html`<span class="note">${r.type}</span>` : null}<span class="tag">${copy(r.state === "completed" ? "done" : r.state === "running" ? "live" : "unsure")}</span></div>
        <p>${r.task}</p>${r.state === "completed" && Number.isFinite(r.durationMs) ? html`<p class="note">${copy("seconds", (r.durationMs / 1000).toFixed(1).replace(/\.0$/, ""))}</p>` : r.state === "running" ? html`<p class="note">${copy("elapsed", Math.max(0, Math.floor((tick - r.startedAt) / 1000)))}</p>` : null}
        ${r.state === "completed" && r.summary ? html`<p class="subagent-report">${r.summary}</p>` : null}</article>`)}
    </section>`)}
    ${value.runs.some(r => r.state === "unknown") ? html`<p class="note">${copy("gap")}</p>` : null}<p class="note">${copy("note")}</p>${value.runs.length >= 16 ? html`<p class="note">${copy("bound")}</p>` : null}
  </div></details>`;
}
