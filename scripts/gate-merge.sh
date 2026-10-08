#!/usr/bin/env bash
# gate-merge.sh — the merge gate the coordinator runs on a reviewer's APPROVE (fleet decision e723a50a).
#
#   gate-merge.sh [--dry-run] [--delivery-json <file>|-] <pr> <approved-sha> <approval-message-id>
#
# The approval's delivery_status result comes from --delivery-json, or stdin when that is not given. delivery_status
# is an MCP tool, so the caller runs it and passes its JSON on. That JSON is a TRUSTED CALLER BOUNDARY: the caller
# must pass exactly what its own delivery_status call returned. content_sha256 is checked against the content, which
# catches an edited content field, but a hash is not authentication of the source. Run the gate from a clone of the
# repository whose `origin` is GATE_REPO.
#
# It merges only when all of these hold, in this order:
#   1. approval: delivery_status has exactly that message, from the reviewer (source_instance starting with
#      GATE_APPROVER), its content_sha256 matches its content, and a line of the content is the verdict for this PR
#      and SHA together, starting the line:  APPROVE — PR #<pr> @<full sha>  (the dash, "PR" and "@" optional).
#      A mention anywhere else — another line, a quote, a different PR's verdict — grants nothing;
#   2. the PR is open and not a draft, and the fetched refs/pull head is gh's head;
#   3. head: the PR head is the approved SHA, or a descendant of it whose own change is unchanged since the approval:
#      the tree is identical, or the fingerprint of the PR's own change (its diff from its merge-base with the base
#      branch, whitespace kept, only index lines and hunk line numbers normalised) is the same, i.e. a merge-sync.
#      Compared on every path except docs/ and changes/: src/ and tests/, and also scripts, workflows and package
#      files. Anything else is NEEDS_REVIEW with the paths;
#   4. the base branch tip is an ancestor of the head (merge-synced);
#   5. CI: every required check (GATE_REQUIRED_CHECKS, plus any the base branch's rulesets require) has a run on the
#      exact head, and every check-run there (the latest run of each name) is completed with conclusion success.
# Then it retargets open PRs based on this PR's branch to this PR's base (stacked PRs), squash-merges with
# --match-head-commit, and deletes the branch only if no open PR is based on it.
#
# A gh write that fails is not taken at its word: the PR is read back. A retarget or merge that did happen counts as
# done; one that did not is rolled back (retargets) or reported; when the read-back fails too, the result is BLOCKED
# "uncertain" and nothing further is changed or reverted. Any git or gh read that fails BLOCKs.
#
# Output: one line on stdout, details on stderr.
#   MERGED <merge-commit-sha>     exit 0
#   WOULD_MERGE <head-sha>        exit 0 (--dry-run: every check ran, nothing was changed)
#   BLOCKED <reason>              exit 1
#   NEEDS_REVIEW <paths…>         exit 3
#   usage error                   exit 2
#
# Environment: GATE_REPO (default songsid/AgEnD), GATE_APPROVER (default agend-reviewer), GATE_REMOTE (default
# origin), GATE_REQUIRED_CHECKS (comma-separated; default main's gate: build, scan, CodeQL,
# Analyze (javascript-typescript), Analyze (actions)).
set -uo pipefail

REPO="${GATE_REPO:-songsid/AgEnD}"
APPROVER="${GATE_APPROVER:-agend-reviewer}"
REMOTE="${GATE_REMOTE:-origin}"
REQUIRED_CHECKS="${GATE_REQUIRED_CHECKS-build,scan,CodeQL,Analyze (javascript-typescript),Analyze (actions)}"
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
    // The verdict binds PR and SHA on one line that starts with APPROVE: "APPROVE — PR #1329 @<sha> …".
    const verdict = /^APPROVE[ \t]*(?:[—–:-][ \t]*)?(?:PR[ \t]*)?#([0-9]+)[ \t]*@?[ \t]*([0-9a-f]{40})(?![0-9a-f])/;
    const verdicts = it.content.split(/\r?\n/).map(l => verdict.exec(l)).filter(Boolean);
    if (!verdicts.some(m => m[1] === PR && m[2] === APPROVED)) {
      say(verdicts.length ? `the APPROVE line(s) are for ${verdicts.map(m => `#${m[1]} @${m[2].slice(0, 12)}`).join(", ")}, not #${PR} @${APPROVED.slice(0, 12)}`
        : "no line \"APPROVE — PR #<pr> @<sha>\" in the message");
    }
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
CROSS="$(printf '%s' "$PRJSON" | json 'String(d.isCrossRepository)')" || blocked "#$PR: isCrossRepository unreadable"
[[ "$HEAD" =~ ^[0-9a-f]{40}$ ]] || blocked "#$PR: malformed head $HEAD"

# Fetch into private refs: never moves a local branch. They are removed on every exit.
trap 'git update-ref -d "refs/gate/pr-$PR" 2>/dev/null; git update-ref -d "refs/gate/base-$PR" 2>/dev/null' EXIT
git fetch -q "$REMOTE" "+refs/pull/$PR/head:refs/gate/pr-$PR" "+refs/heads/$BASE_REF:refs/gate/base-$PR" 2>/dev/null \
  || blocked "git fetch of #$PR and $BASE_REF failed"
FETCHED="$(git rev-parse "refs/gate/pr-$PR")" || blocked "git rev-parse of the fetched head failed"
[ "$FETCHED" = "$HEAD" ] || blocked "#$PR moved while gating (fetched head is not $HEAD)"
BASE_TIP="$(git rev-parse "refs/gate/base-$PR")" || blocked "git rev-parse of $BASE_REF failed"

# ── 3. Head = approved, or an unchanged carry ───────────────────────────────────────────────────────────────────
CODE_PATHS=(. ':(exclude)docs' ':(exclude)changes')
# own_fingerprint <commit> [path…]: a hash of the PR's own change at <commit> — its diff from its merge-base with the
# base — keeping every byte of whitespace (git patch-id would not); only `index` lines and hunk line numbers, which a
# merge-sync moves, are normalised. Fails (non-zero) when any git step fails.
own_fingerprint() {
  local c="$1"; shift
  local mb; mb="$(git merge-base "$BASE_TIP" "$c")" || return 1
  git diff --binary --no-color --no-ext-diff --no-renames -U3 "$mb" "$c" -- "$@" \
    | sed -e '/^index [0-9a-f]*\.\.[0-9a-f]*/d' -e 's/^@@ -[0-9,]* +[0-9,]* @@/@@/' \
    | git hash-object --stdin
}
# same_tree <a> <b> [path…]: 0 identical, 1 different, 2 git failed.
same_tree() {
  local a="$1" b="$2"; shift 2
  git diff --quiet "$a" "$b" -- "$@"; local rc=$?
  [ "$rc" -le 1 ] && return "$rc"; return 2
}
CARRY=""
if [ "$HEAD" != "$APPROVED" ]; then
  git cat-file -e "$APPROVED^{commit}" 2>/dev/null || { echo "NEEDS_REVIEW the approved $APPROVED is not in #$PR's history (force-push?)"; exit 3; }
  git merge-base --is-ancestor "$APPROVED" "$HEAD"; rc=$?
  [ "$rc" -le 1 ] || blocked "git merge-base --is-ancestor failed"
  [ "$rc" -eq 0 ] || { echo "NEEDS_REVIEW #$PR head $HEAD does not descend from the approved $APPROVED"; exit 3; }
  same_tree "$APPROVED" "$HEAD" "${CODE_PATHS[@]}"; rc=$?
  [ "$rc" -le 1 ] || blocked "git diff of the approved and current heads failed"
  if [ "$rc" -eq 0 ]; then
    CARRY="tree"
  else
    FA="$(own_fingerprint "$APPROVED" "${CODE_PATHS[@]}")" || blocked "git failed fingerprinting the approved change"
    FH="$(own_fingerprint "$HEAD" "${CODE_PATHS[@]}")" || blocked "git failed fingerprinting the current change"
    if [ "$FA" = "$FH" ]; then
      CARRY="own-change"
    else
      # The files whose own change differs between the approval and now.
      MBA="$(git merge-base "$BASE_TIP" "$APPROVED")" || blocked "git merge-base failed"
      MBH="$(git merge-base "$BASE_TIP" "$HEAD")" || blocked "git merge-base failed"
      LIST_A="$(git diff --name-only --no-renames "$MBA" "$APPROVED" -- "${CODE_PATHS[@]}")" || blocked "git diff --name-only failed"
      LIST_H="$(git diff --name-only --no-renames "$MBH" "$HEAD" -- "${CODE_PATHS[@]}")" || blocked "git diff --name-only failed"
      CHANGED=()
      while IFS= read -r f; do
        [ -n "$f" ] || continue
        a="$(own_fingerprint "$APPROVED" "$f")" || blocked "git failed fingerprinting $f"
        h="$(own_fingerprint "$HEAD" "$f")" || blocked "git failed fingerprinting $f"
        [ "$a" = "$h" ] || CHANGED+=("$f")
      done < <(printf '%s\n%s\n' "$LIST_A" "$LIST_H" | sort -u)
      echo "NEEDS_REVIEW ${CHANGED[*]:-(own change differs)}"
      exit 3
    fi
  fi
  note "head $HEAD carries the approval of $APPROVED ($CARRY-identical outside docs/ and changes/)"
fi

# ── 4. Merge-synced ─────────────────────────────────────────────────────────────────────────────────────────────
git merge-base --is-ancestor "$BASE_TIP" "$HEAD"; rc=$?
[ "$rc" -le 1 ] || blocked "git merge-base --is-ancestor failed"
[ "$rc" -eq 0 ] || blocked "#$PR is behind $BASE_REF ($BASE_TIP): merge-sync first"

# ── 5. CI on the exact head ─────────────────────────────────────────────────────────────────────────────────────
# GitHub's CodeQL default setup does not run on release/** branches, so CodeQL and Analyze(*)
# are optional there: their absence does not block, but a present FAILURE still does.
# build and scan are required regardless of base branch.
# Only applies when GATE_REQUIRED_CHECKS is not set by the caller (i.e. using the default).
EFFECTIVE_CHECKS="$REQUIRED_CHECKS"
if [[ "$BASE_REF" == release/* ]] && [ -z "${GATE_REQUIRED_CHECKS+x}" ]; then
  EFFECTIVE_CHECKS="build,scan"
fi
RULES="$(gh api "repos/$REPO/rules/branches/$BASE_REF" 2>/dev/null)" || blocked "the rules of $BASE_REF are unreadable"
RUNS="$(gh api "repos/$REPO/commits/$HEAD/check-runs?per_page=100" 2>/dev/null)" || blocked "check-runs for $HEAD unreadable"
CI="$(printf '%s' "$RUNS" | REQUIRED_CHECKS="$EFFECTIVE_CHECKS" RULES="$RULES" node -e '
  let s = ""; process.stdin.on("data", c => s += c).on("end", () => {
    const out = m => { process.stdout.write(m); process.exit(0); };
    let d, rules;
    try { d = JSON.parse(s); rules = JSON.parse(process.env.RULES); } catch { out("check-runs or rules are not JSON"); }
    // One page holds 100; more than that is not this repository, and a partial list must not pass.
    if (!Array.isArray(d.check_runs) || d.total_count > d.check_runs.length) out(`${d.total_count} check-runs, read ${d.check_runs?.length ?? 0}`);
    const required = new Set(process.env.REQUIRED_CHECKS.split(",").map(n => n.trim()).filter(Boolean));
    for (const r of Array.isArray(rules) ? rules : []) {
      if (r?.type === "required_status_checks") for (const c of r.parameters?.required_status_checks ?? []) if (c?.context) required.add(c.context);
    }
    const latest = new Map();
    for (const run of d.check_runs) {
      const prev = latest.get(run.name);
      if (!prev || run.id > prev.id) latest.set(run.name, run);
    }
    const missing = [...required].filter(n => !latest.has(n)).map(n => `${n}=missing`);
    const bad = [...latest.values()].filter(r => r.status !== "completed" || r.conclusion !== "success")
      .map(r => `${r.name}=${r.status === "completed" ? r.conclusion : r.status}`);
    if (latest.size === 0 && missing.length === 0) out("no check-runs");
    out([...missing, ...bad].join(",") || "OK");
  });')" || blocked "check-runs for $HEAD unparseable"
[ "$CI" = "OK" ] || blocked "CI on $HEAD: $CI"

# ── Stacked PRs based on this branch ────────────────────────────────────────────────────────────────────────────
dependents() { # open PRs whose base is this PR's branch (only meaningful when the branch lives in this repo)
  [ "$CROSS" = "false" ] || return 0
  gh pr list -R "$REPO" --state open --base "$HEAD_REF" --json number 2>/dev/null | json 'd.map(p => p.number).join(" ")'
}
# pr_base <n>: the PR's current base branch, read back from GitHub (non-zero when unreadable).
pr_base() { gh pr view "$1" -R "$REPO" --json baseRefName 2>/dev/null | json d.baseRefName; }
DEPS="$(dependents)" || blocked "cannot list PRs based on $HEAD_REF"

if [ "$DRY_RUN" = 1 ]; then
  [ -n "$DEPS" ] && note "would retarget #${DEPS// / #} from $HEAD_REF to $BASE_REF"
  echo "WOULD_MERGE $HEAD"
  exit 0
fi

# put_back: return every confirmed retarget to this branch. A put-back that fails is read back too; any that cannot
# be confirmed is named, never retried blindly.
put_back() {
  local m b
  for m in "${RETARGETED[@]}"; do
    gh pr edit "$m" -R "$REPO" --base "$HEAD_REF" >/dev/null 2>&1 && continue
    b="$(pr_base "$m")" || { note "#$m: could not put it back on $HEAD_REF, and its base is unreadable"; continue; }
    [ "$b" = "$HEAD_REF" ] || note "#$m: could not put it back on $HEAD_REF (its base is $b)"
  done
}

RETARGETED=()
for n in $DEPS; do
  if ! gh pr edit "$n" -R "$REPO" --base "$BASE_REF" >/dev/null 2>&1; then
    # The edit may have happened with only its answer lost: read the base back before deciding.
    if ! b="$(pr_base "$n")"; then
      blocked "uncertain: retargeting #$n failed and its base is unreadable; nothing reverted (done: ${RETARGETED[*]:-none})"
    fi
    if [ "$b" != "$BASE_REF" ]; then
      put_back
      blocked "could not retarget #$n from $HEAD_REF to $BASE_REF"
    fi
    note "#$n: gh reported a failure, but its base is now $BASE_REF"
  fi
  RETARGETED+=("$n"); note "retargeted #$n to $BASE_REF"
done

# ── Merge ───────────────────────────────────────────────────────────────────────────────────────────────────────
MERGE_OK=1
MERGE_ERR="$(gh pr merge "$PR" -R "$REPO" --squash --match-head-commit "$HEAD" 2>&1 >/dev/null)" || MERGE_OK=0
# Whatever gh said, GitHub's state decides what happened.
AFTER="$(gh pr view "$PR" -R "$REPO" --json state,mergeCommit 2>/dev/null)" \
  || blocked "uncertain: gh pr merge $([ "$MERGE_OK" = 1 ] && echo returned || echo failed) and #$PR is unreadable; nothing reverted (retargeted: ${RETARGETED[*]:-none})"
AFTER_STATE="$(printf '%s' "$AFTER" | json d.state)" || blocked "uncertain: #$PR has no state after the merge; nothing reverted"
if [ "$AFTER_STATE" != "MERGED" ]; then
  put_back
  if [ "$MERGE_OK" = 1 ]; then blocked "gh pr merge returned but #$PR is $AFTER_STATE"; fi
  blocked "merge failed: $(printf '%s' "$MERGE_ERR" | head -n 1)"
fi
[ "$MERGE_OK" = 1 ] || note "gh pr merge reported a failure, but #$PR is MERGED"
MERGE_SHA="$(printf '%s' "$AFTER" | json 'd.mergeCommit && d.mergeCommit.oid')" || MERGE_SHA="(unknown)"

# The branch goes only if nothing is based on it any more (a PR opened on it since the retarget keeps it).
if [ "$CROSS" = "false" ]; then
  if LEFT="$(dependents)"; then
    if [ -z "$LEFT" ]; then
      gh api -X DELETE "repos/$REPO/git/refs/heads/$HEAD_REF" >/dev/null 2>&1 && note "deleted $HEAD_REF" || note "could not delete $HEAD_REF"
    else
      note "kept $HEAD_REF: open PRs are based on it ($LEFT)"
    fi
  else
    note "kept $HEAD_REF: could not list the PRs based on it"
  fi
fi
echo "MERGED $MERGE_SHA"
