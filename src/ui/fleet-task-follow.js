// Who hears about a card, in the card page's property column (fleet-task-card.js): its watchers — instances the person
// (or an instance) set on it, added and removed here — and its leader, the project's lead or the board's default, which
// is read-only here (a project's lead is set on the project, the default in Settings). Both are the people-and-instances
// side of "Following a card" (docs/design/task-board.md): a follower is told when the card is finished, waits for a
// confirmation, is sent back, is blocked or changes hands.
// The writes go through the page's own `follow(change)` (POST /ui/tasks/cards/<id>/watchers); a refusal — an instance
// that has the task board off, a card with ten watchers already — reaches the person as the page's toast in its own words
// (tasks.err.<key>), the same as every other write on the page.
import { html } from "/assets/app-html.js";
import { t, register } from "/assets/app-i18n.js";
import { Icon } from "/assets/ui-icons.js";
import { Menu } from "/assets/ui-menu.js";
import { Who } from "./fleet-task-common.js";

register("taskfollow", {
  en: {
    watchers: "Watchers", watchersHint: "Instances that hear this card's progress: finished, waiting for confirmation, sent back, blocked or handed over",
    noWatchers: "Nobody", add: "Add", addTitle: "Add a watcher", full: "A card has at most {0} watchers: remove one to add another",
    noneToAdd: "Every instance in the fleet already watches this card", remove: "Stop {0} watching this card", gone: "{0} is no longer in the fleet",
    fromMain: "Also from {0}: {1}", leader: "Leader", leaderNone: "None", count: " ({0}/{1})",
    leaderHint: "The instance that hears this card's progress because it leads the card's project, or the board when the card has no project lead",
    viaProject: "project lead", viaBoard: "board default",
    leaderAssignee: "It has the card, so it hears the card's own news", leaderGone: "Not in the fleet: nobody is told", leaderBoardOff: "Its task board is off: nobody is told",
    leaderNoNotices: "Progress notices are switched off for the fleet: nobody is told",
    leaderNoneHint: "Nobody is named as this card's leader",
  },
  "zh-TW": {
    watchers: "關注者", watchersHint: "會收到這張卡進度通知的 Agent：完成、等確認、被退回、卡住或換手時",
    noWatchers: "沒有", add: "新增", addTitle: "新增關注者", full: "一張卡最多 {0} 個關注者：先移除一個才能再新增",
    noneToAdd: "fleet 裡的 Agent 都已經在關注這張卡", remove: "讓 {0} 不再關注這張卡", gone: "{0} 已不在 fleet 中",
    fromMain: "另外從 {0} 來：{1}", leader: "看板負責人", leaderNone: "沒有",
    leaderHint: "會收到這張卡進度通知的專案負責人（卡所屬專案沒有專案負責人時，則是任務板預設的看板負責人）",
    viaProject: "專案負責人", viaBoard: "任務板預設",
    leaderAssignee: "它就是這張卡的負責人，本來就會收到這張卡自己的訊息", leaderGone: "已不在 fleet 中：不會通知任何人", leaderBoardOff: "它的任務板已關閉：不會通知任何人",
    leaderNoNotices: "fleet 已關閉進度通知：不會通知任何人", count: "（{0}/{1}）",
    leaderNoneHint: "這張卡沒有看板負責人",
  },
});

/** A card has at most this many watchers (MAX_WATCHERS in scheduler/task-board.ts, which refuses the eleventh too). */
export const WATCH_MAX = 10;

/**
 * What the Add menu lists (pure: tests import it): the fleet's instances that do not watch the card yet, one with the task
 * board off disabled and saying why (the board refuses it), and none of them once the card has {@link WATCH_MAX}.
 */
export function watchItems({ names, watchers, boardOff = [], act }) {
  const have = new Set(watchers);
  return [...new Set(names)].filter((n) => !have.has(n)).sort((a, b) => a.localeCompare(b)).map((n) => {
    const off = boardOff.includes(n);
    return { key: `n:${n}`, label: off ? t("tasks.boardOff", n) : n, disabled: off, title: off ? t("tasks.boardOffHint") : undefined, onSelect: () => act(n) };
  });
}

/**
 * Why the leader would hear nothing of this card, in words (null: it will hear it). Whether it is told at all is the board's
 * rule (followersOf): not the card's own assignee, a fleet instance, task board on — and the fleet's notices switched on.
 */
export function leaderCaveat({ leader, assignee, names, boardOff = [], followsProgress = true }) {
  if (!leader) return null;
  if (!followsProgress) return t("taskfollow.leaderNoNotices");
  if (!names.includes(leader.name)) return t("taskfollow.leaderGone");
  if (boardOff.includes(leader.name)) return t("taskfollow.leaderBoardOff");
  if (leader.name === assignee) return t("taskfollow.leaderAssignee");
  return null;
}

/** What both rows read from the board's detail (`names`: the fleet's instance names). */
function followModel({ detail, names, boardOff = [], can, follow }) {
  const { card, parent } = detail;
  const watchers = detail.watchers || [];
  const inherited = (detail.inheritedWatchers || []).filter((n) => !watchers.includes(n));
  const leader = detail.leader || null;
  const full = watchers.length >= WATCH_MAX;
  const choices = watchItems({ names, watchers, boardOff, act: (n) => void follow({ add: [n] }) });
  const caveat = leaderCaveat({ leader, assignee: card.assignee, names, boardOff, followsProgress: detail.followsProgress !== false });
  // Over a read-only link, an instance kept out of sight is not named at all (the server leaves it out).
  const nameOf = (n) => html`<${Who} name=${n} title=${names.includes(n) ? n : t("taskfollow.gone", n)} />`;
  return { parent, watchers, inherited, leader, full, choices, caveat, nameOf, can, follow };
}

/**
 * The Watchers row (the card page puts it in the "Project and people" group, after the dispatcher). `detail`: the card as the
 * board reads it (`watchers`, `inheritedWatchers`); `names`: the fleet's instance names; `can`: false over a read-only link
 * (the list only); `follow`: `({ add?, remove? }) => Promise`, the page's write.
 */
export function WatchersRow(props) {
  const { parent, watchers, inherited, full, choices, nameOf, can, follow } = followModel(props);
  const addMenu = !can ? null : full
    ? html`<span class="tc-hint muted tp-watch-note">${t("taskfollow.full", WATCH_MAX)}</span>`
    : choices.length
      ? html`<${Menu} cls="tp-chip-menu tp-watch-add" label=${t("taskfollow.addTitle")} fit triggerClass="btn btn-ghost btn-sm" items=${choices}
          trigger=${html`<${Icon} name="plus" size=${14} />${t("taskfollow.add")}`} />`
      : html`<span class="tc-hint muted tp-watch-note">${t("taskfollow.noneToAdd")}</span>`;
  return html`<div class="tp-row tp-block" data-follow="watchers">
      <dt title=${t("taskfollow.watchersHint")}>${t("taskfollow.watchers")}${watchers.length ? html`<span class="muted">${t("taskfollow.count", watchers.length, WATCH_MAX)}</span>` : null}</dt>
      <dd class="tp-watchers">
        ${watchers.length ? html`<ul class="tp-watch-list">${watchers.map((n) => html`<li key=${n} class="tp-watch" data-watcher=${n}>${nameOf(n)}
          ${can ? html`<button type="button" class="icon-btn tp-watch-x" aria-label=${t("taskfollow.remove", n)} title=${t("taskfollow.remove", n)} onClick=${() => void follow({ remove: [n] })}><${Icon} name="close" size=${14} /></button>` : null}</li>`)}</ul>`
          : html`<span class="muted tp-watch-none">${t("taskfollow.noWatchers")}</span>`}
        ${addMenu}
        ${inherited.length && parent ? html`<span class="muted tc-hint tp-watch-note">${t("taskfollow.fromMain", parent.id, inherited.join(", "))}</span>` : null}
      </dd>
    </div>`;
}

/** The Leader row (read-only: a project's lead is set on the project, the default in Settings). Same props as {@link WatchersRow}. */
export function LeaderRow(props) {
  const { leader, caveat, nameOf } = followModel(props);
  return html`<div class="tp-row" data-follow="leader">
      <dt title=${t("taskfollow.leaderHint")}>${t("taskfollow.leader")}</dt>
      <dd class="tp-leader">
        ${leader ? html`${nameOf(leader.name)}<span class="tp-leader-via muted">${t(leader.via === "project" ? "taskfollow.viaProject" : "taskfollow.viaBoard")}</span>
            ${caveat ? html`<span class="tc-hint muted tp-watch-note tp-leader-note">${caveat}</span>` : null}`
          : html`<span class="muted" title=${t("taskfollow.leaderNoneHint")}>${t("taskfollow.leaderNone")}</span>`}
      </dd>
    </div>`;
}

/** Both rows, watchers first (the order before the card page grouped its properties). */
export function FollowRows(props) {
  return html`<${WatchersRow} ...${props} /><${LeaderRow} ...${props} />`;
}
