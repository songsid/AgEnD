#!/usr/bin/env bash
# gate-merge.sh — the merge gate the coordinator runs on a reviewer's APPROVE (fleet decision e723a50a).
#
#   gate-merge.sh [--dry-run] [--delivery-json <file>|-] <pr> <approved-sha> <approval-message-id>
#
# The approval's delivery_status result (an MCP tool, so the caller saves its JSON) comes from --delivery-json, or
# stdin when that is not given. Run it from a clone of the repository whose `origin` is GATE_REPO.
#
# It merges only when all of these hold, in this order:
#   1. approval: delivery_status has exactly that message, from the reviewer (source_instance starting with
#      GATE_APPROVER), its content_sha256 matches its content, and the content says APPROVE (not REQUEST_CHANGES),
#      names #<pr> and contains the full approved SHA;
#   2. the PR is open and not a draft;
#   3. head: the PR head is the approved SHA, or a descendant of it whose own change is unchanged since the approval:
#      the tree is identical, or the patch-id of the PR's change from its merge-base with the base branch is the same
#      (a merge-sync). Compared on every path except docs/ and changes/ — src/ and tests/, and also scripts, workflows
#      and package files, which are code too. Anything else is NEEDS_REVIEW with the paths;
#   4. the base branch tip is an ancestor of the head (merge-synced);
#   5. every check-run on the exact head SHA (the latest run of each name) is completed with conclusion success.
# Then it retargets open PRs based on this PR's branch to this PR's base (stacked PRs), squash-merges with
# --match-head-commit, and deletes the branch only if no open PR is based on it. If the merge fails, the retargets
# are put back.
#
# Output: one line on stdout, details on stderr.
#   MERGED <merge-commit-sha>     exit 0
#   WOULD_MERGE <head-sha>        exit 0 (--dry-run: every check ran, nothing was changed)
#   BLOCKED <reason>              exit 1
#   NEEDS_REVIEW <paths…>         exit 3
#   usage error                   exit 2
#
# Environment: GATE_REPO (default songsid/AgEnD), GATE_APPROVER (default agend-reviewer), GATE_REMOTE (default origin).
set -uo pipefail

REPO="${GATE_REPO:-songsid/AgEnD}"
APPROVER="${GATE_APPROVER:-agend-reviewer}"
REMOTE="${GATE_REMOTE:-origin}"
DRY_RUN=0
DELIVERY_JSON=""

usage() { echo "usage: gate-merge.sh [--dry-run] [--delivery-json <file>|-] <pr> <approved-sha> <approval-message-id>" >&2; exit 2; }
blocked() { echo "BLOCKED $*"; exit 1; }
note() { echo "gate-merge: $*" >&2; }

ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --delivery-json) [ $# -ge 2 ] || usage; DELIVERY_JSON="$2"; shift ;;
    --*) usage ;;
    *) ARGS+=("$1") ;;
  esac
  shift
done
[ "${#ARGS[@]}" -eq 3 ] || usage
PR="${ARGS[0]}"; APPROVED="${ARGS[1]}"; MESSAGE_ID="${ARGS[2]}"
[[ "$PR" =~ ^[1-9][0-9]*$ ]] || usage
[[ "$APPROVED" =~ ^[0-9a-f]{40}$ ]] || { echo "gate-merge: the approved SHA must be the full 40-hex SHA" >&2; usage; }
[ -n "$MESSAGE_ID" ] || usage
command -v node >/dev/null || blocked "node is not on PATH"
command -v gh >/dev/null || blocked "gh is not on PATH"

# json <expression over `d`> — evaluates against the JSON on stdin and prints the result (strings bare, else JSON).
json() {
  node -e '
    let s = ""; process.stdin.on("data", c => s += c).on("end", () => {
      let d; try { d = JSON.parse(s); } catch { process.exit(4); }
      const v = (0, eval)("(d) => (" + process.argv[1] + ")")(d);
      if (v === undefined || v === null) process.exit(5);
      process.stdout.write(typeof v === "string" ? v : JSON.stringify(v));
    });' "$1"
}

# ── 1. The approval message ─────────────────────────────────────────────────────────────────────────────────────
if [ -z "$DELIVERY_JSON" ] || [ "$DELIVERY_JSON" = "-" ]; then
  # Never wait on a terminal: an unattended caller would hang here for good.
  [ -t 0 ] && { echo "gate-merge: pipe the delivery_status JSON in, or pass --delivery-json <file>" >&2; exit 2; }
  DELIVERY="$(cat)"
else
  [ -r "$DELIVERY_JSON" ] || blocked "approval not verified: cannot read $DELIVERY_JSON"
  DELIVERY="$(cat -- "$DELIVERY_JSON")"
fi
VERDICT="$(printf '%s' "$DELIVERY" | MESSAGE_ID="$MESSAGE_ID" APPROVED="$APPROVED" PR="$PR" APPROVER="$APPROVER" node -e '
  const { createHash } = require("node:crypto");
  let s = ""; process.stdin.on("data", c => s += c).on("end", () => {
    const say = m => { process.stdout.write(m); process.exit(0); };
    let d; try { d = JSON.parse(s); } catch { say("delivery_status is not JSON (Delivery not found?)"); }
    const { MESSAGE_ID, APPROVED, PR, APPROVER } = process.env;
    const items = (Array.isArray(d?.items) ? d.items : [d]).filter(i => i && i.message_id === MESSAGE_ID);
    if (items.length !== 1) say(`delivery_status has ${items.length} deliveries with message_id ${MESSAGE_ID}`);
    const it = items[0];
    if (typeof it.source_instance !== "string" || !it.source_instance.startsWith(APPROVER)) say(`message is from ${it.source_instance}, not ${APPROVER}*`);
    if (typeof it.content !== "string") say("delivery has no content");
    const digest = createHash("sha256").update(it.content, "utf8").digest("hex");
    if (it.content_sha256 !== digest) say("content_sha256 does not match the content");
    if (!/\bAPPROVE[D]?\b/.test(it.content)) say("the message does not say APPROVE");
    if (/\bREQUEST[_ ]CHANGES\b/i.test(it.content)) say("the message says REQUEST_CHANGES");
    if (!new RegExp(`#${PR}(?![0-9])`).test(it.content)) say(`the message does not name #${PR}`);
    if (!new RegExp(`(?<![0-9a-f])${APPROVED}(?![0-9a-f])`).test(it.content)) say(`the message does not contain ${APPROVED}`);
    say("OK");
  });')"
[ "$VERDICT" = "OK" ] || blocked "approval not verified: ${VERDICT:-delivery_status unreadable}"

# ── 2. The PR ───────────────────────────────────────────────────────────────────────────────────────────────────
PRJSON="$(gh pr view "$PR" -R "$REPO" --json state,isDraft,headRefOid,headRefName,baseRefName,isCrossRepository 2>/dev/null)" \
  || blocked "gh pr view #$PR failed"
STATE="$(printf '%s' "$PRJSON" | json d.state)" || blocked "gh pr view #$PR: no state"
[ "$STATE" = "OPEN" ] || blocked "#$PR is $STATE"
[ "$(printf '%s' "$PRJSON" | json 'String(d.isDraft)')" = "false" ] || blocked "#$PR is a draft"
HEAD="$(printf '%s' "$PRJSON" | json d.headRefOid)" || blocked "#$PR: no head"
HEAD_REF="$(printf '%s' "$PRJSON" | json d.headRefName)" || blocked "#$PR: no head branch"
BASE_REF="$(printf '%s' "$PRJSON" | json d.baseRefName)" || blocked "#$PR: no base branch"
CROSS="$(printf '%s' "$PRJSON" | json 'String(d.isCrossRepository)')" || CROSS=true
[[ "$HEAD" =~ ^[0-9a-f]{40}$ ]] || blocked "#$PR: malformed head $HEAD"

# Fetch into private refs: never moves a local branch. They are removed on every exit.
trap 'git update-ref -d "refs/gate/pr-$PR" 2>/dev/null; git update-ref -d "refs/gate/base-$PR" 2>/dev/null' EXIT
git fetch -q "$REMOTE" "+refs/pull/$PR/head:refs/gate/pr-$PR" "+refs/heads/$BASE_REF:refs/gate/base-$PR" 2>/dev/null \
  || blocked "git fetch of #$PR and $BASE_REF failed"
[ "$(git rev-parse "refs/gate/pr-$PR")" = "$HEAD" ] || blocked "#$PR moved while gating (fetched head is not $HEAD)"
BASE_TIP="$(git rev-parse "refs/gate/base-$PR")"

# ── 3. Head = approved, or an unchanged carry ───────────────────────────────────────────────────────────────────
CODE_PATHS=(. ':(exclude)docs' ':(exclude)changes')
own_patch_id() { # <commit> [path…]: patch-id of the PR's own change at <commit>, from its merge-base with the base
  local c="$1"; shift
  local mb; mb="$(git merge-base "$BASE_TIP" "$c")" || return 1
  git diff "$mb" "$c" -- "$@" | git patch-id --stable | cut -d' ' -f1
}
CARRY=""
if [ "$HEAD" != "$APPROVED" ]; then
  git cat-file -e "$APPROVED^{commit}" 2>/dev/null || { echo "NEEDS_REVIEW the approved $APPROVED is not in #$PR's history (force-push?)"; exit 3; }
  git merge-base --is-ancestor "$APPROVED" "$HEAD" || { echo "NEEDS_REVIEW #$PR head $HEAD does not descend from the approved $APPROVED"; exit 3; }
  if git diff --quiet "$APPROVED" "$HEAD" -- "${CODE_PATHS[@]}"; then
    CARRY="tree"
  elif [ "$(own_patch_id "$APPROVED" "${CODE_PATHS[@]}")" = "$(own_patch_id "$HEAD" "${CODE_PATHS[@]}")" ]; then
    CARRY="patch-id"
  else
    # The files whose own change differs between the approval and now.
    mapfile -t FILES < <( { git diff --name-only "$(git merge-base "$BASE_TIP" "$APPROVED")" "$APPROVED" -- "${CODE_PATHS[@]}"
                            git diff --name-only "$(git merge-base "$BASE_TIP" "$HEAD")" "$HEAD" -- "${CODE_PATHS[@]}"; } | sort -u)
    CHANGED=()
    for f in "${FILES[@]}"; do
      [ "$(own_patch_id "$APPROVED" "$f")" = "$(own_patch_id "$HEAD" "$f")" ] || CHANGED+=("$f")
    done
    echo "NEEDS_REVIEW ${CHANGED[*]:-(own change differs)}"
    exit 3
  fi
  note "head $HEAD carries the approval of $APPROVED ($CARRY-identical outside docs/ and changes/)"
fi

# ── 4. Merge-synced ─────────────────────────────────────────────────────────────────────────────────────────────
git merge-base --is-ancestor "$BASE_TIP" "$HEAD" || blocked "#$PR is behind $BASE_REF ($BASE_TIP): merge-sync first"

# ── 5. CI on the exact head ─────────────────────────────────────────────────────────────────────────────────────
RUNS="$(gh api "repos/$REPO/commits/$HEAD/check-runs?per_page=100" 2>/dev/null)" || blocked "check-runs for $HEAD unreadable"
CI="$(printf '%s' "$RUNS" | node -e '
  let s = ""; process.stdin.on("data", c => s += c).on("end", () => {
    const d = JSON.parse(s);
    // One page holds 100; more than that is not this repository, and a partial list must not pass.
    if (!Array.isArray(d.check_runs) || d.total_count > d.check_runs.length) { process.stdout.write(`${d.total_count} check-runs, read ${d.check_runs?.length ?? 0}`); return; }
    const latest = new Map();
    for (const run of d.check_runs) {
      const prev = latest.get(run.name);
      if (!prev || run.id > prev.id) latest.set(run.name, run);
    }
    if (latest.size === 0) { process.stdout.write("no check-runs"); return; }
    const bad = [...latest.values()].filter(r => r.status !== "completed" || r.conclusion !== "success")
      .map(r => `${r.name}=${r.status === "completed" ? r.conclusion : r.status}`);
    process.stdout.write(bad.length ? bad.join(",") : "OK");
  });')" || blocked "check-runs for $HEAD unparseable"
[ "$CI" = "OK" ] || blocked "CI on $HEAD: $CI"

# ── Stacked PRs based on this branch ────────────────────────────────────────────────────────────────────────────
dependents() { # open PRs whose base is this PR's branch (only meaningful when the branch lives in this repo)
  [ "$CROSS" = "false" ] || return 0
  gh pr list -R "$REPO" --state open --base "$HEAD_REF" --json number 2>/dev/null | json 'd.map(p => p.number).join(" ")'
}
DEPS="$(dependents)" || blocked "cannot list PRs based on $HEAD_REF"

if [ "$DRY_RUN" = 1 ]; then
  [ -n "$DEPS" ] && note "would retarget #${DEPS// / #} from $HEAD_REF to $BASE_REF"
  echo "WOULD_MERGE $HEAD"
  exit 0
fi

RETARGETED=()
for n in $DEPS; do
  if gh pr edit "$n" -R "$REPO" --base "$BASE_REF" >/dev/null 2>&1; then RETARGETED+=("$n"); note "retargeted #$n to $BASE_REF"
  else
    for m in "${RETARGETED[@]}"; do gh pr edit "$m" -R "$REPO" --base "$HEAD_REF" >/dev/null 2>&1 || note "could not put #$m back on $HEAD_REF"; done
    blocked "could not retarget #$n from $HEAD_REF to $BASE_REF"
  fi
done

# ── Merge ───────────────────────────────────────────────────────────────────────────────────────────────────────
if ! MERGE_ERR="$(gh pr merge "$PR" -R "$REPO" --squash --match-head-commit "$HEAD" 2>&1 >/dev/null)"; then
  for m in "${RETARGETED[@]}"; do gh pr edit "$m" -R "$REPO" --base "$HEAD_REF" >/dev/null 2>&1 || note "could not put #$m back on $HEAD_REF"; done
  blocked "merge failed: $(printf '%s' "$MERGE_ERR" | head -n 1)"
fi
AFTER="$(gh pr view "$PR" -R "$REPO" --json state,mergeCommit 2>/dev/null)" || blocked "merged? gh pr view #$PR failed afterwards"
[ "$(printf '%s' "$AFTER" | json d.state)" = "MERGED" ] || blocked "gh pr merge returned but #$PR is not MERGED"
MERGE_SHA="$(printf '%s' "$AFTER" | json 'd.mergeCommit && d.mergeCommit.oid')" || MERGE_SHA="(unknown)"

# The branch goes only if nothing is based on it any more (a PR opened on it since the retarget keeps it).
if [ "$CROSS" = "false" ]; then
  LEFT="$(dependents)" || LEFT="unknown"
  if [ -z "$LEFT" ]; then
    gh api -X DELETE "repos/$REPO/git/refs/heads/$HEAD_REF" >/dev/null 2>&1 && note "deleted $HEAD_REF" || note "could not delete $HEAD_REF"
  else
    note "kept $HEAD_REF: open PRs are based on it ($LEFT)"
  fi
fi
echo "MERGED $MERGE_SHA"
