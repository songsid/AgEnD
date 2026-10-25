#!/usr/bin/env node
// Local operator tool, not an agent/HTTP interface. Receipts are authority only inside this user's clone.
import { spawnSync } from 'node:child_process';
import { constants, lstatSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, renameSync, unlinkSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';

const repo = process.env.GATE_REPO || 'songsid/AgEnD';
const remote = process.env.GATE_REMOTE || 'origin';
const sha = s => typeof s === 'string' && /^[a-f0-9]{40}$/.test(s);
const requireThat = (ok, why) => { if (!ok) throw new Error(why); };
function run(exe, args, cwd = process.cwd()) {
  const r = spawnSync(exe, args, { cwd, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
  requireThat(!r.error && r.status === 0, `${exe} read/write failed: ${r.error?.message || r.stderr?.slice(0, 300)}`);
  return r.stdout;
}
const git = (...args) => run('git', args);
const gh = (...args) => JSON.parse(run('gh', args));
const api = path => gh('api', `repos/${repo}/${path}`);
function paths(base, head) { return new Set(git('diff', '--name-only', '-z', '--no-renames', base, head, '--').split('\0').filter(Boolean)); }
function overlap(base, head) {
  const mb = git('merge-base', base, head).trim();
  const upstream = paths(mb, base), own = paths(mb, head);
  const collisions = [...upstream].filter(p => own.has(p) || globalPath(p));
  return collisions.length ? `OVERLAP ${JSON.stringify(collisions)}` : 'DISJOINT';
}
// Main's package, lockfile and workflow changes always need a merge-sync, however cleanly they would merge.
const globalPath = p => p === 'package.json' || p === 'package-lock.json' || p.startsWith('.github/');
// mergeCheck: DISJOINT, CLEAN [paths] (overlapping, but a three-way merge of base and head has no conflict),
// CONFLICT [paths], or OVERLAP [paths] when main changed a global path. Any git failure throws (→ BLOCKED).
function mergeCheck(base, head) {
  const verdict = overlap(base, head);
  if (verdict === 'DISJOINT') return verdict;
  const mb = git('merge-base', base, head).trim();
  const upstream = paths(mb, base), own = paths(mb, head);
  const global = [...upstream].filter(globalPath);
  if (global.length) return `OVERLAP ${JSON.stringify(global)}`;
  const shared = JSON.stringify([...upstream].filter(p => own.has(p)));
  return threeWayClean(base, head) ? `CLEAN ${shared}` : `CONFLICT ${shared}`;
}
// threeWayClean: git merge-tree --write-tree (git ≥ 2.38: 0 clean, 1 conflicted, the tree id first either way). An
// older git does not know --write-tree, so the merge runs in a private scratch worktree instead and is thrown away.
function threeWayClean(base, head) {
  const t = spawnSync('git', ['merge-tree', '--write-tree', '--no-messages', base, head], { encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
  if (!t.error && (t.status === 0 || t.status === 1) && sha(t.stdout.split('\n')[0])) return t.status === 0;
  const scratch = join(store(), `merge-check-${randomBytes(6).toString('hex')}`);
  git('worktree', 'add', '-q', '--detach', scratch, base);
  try {
    const m = spawnSync('git', ['-c', 'rerere.enabled=false', '-c', 'user.name=gate', '-c', 'user.email=gate@invalid', 'merge', '-q', '--no-commit', '--no-ff', '--no-edit', head],
      { cwd: scratch, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
    requireThat(!m.error && m.status !== null, `git merge failed: ${m.error?.message}`);
    if (m.status === 0) return true;
    requireThat(run('git', ['ls-files', '-u'], scratch).trim() !== '', `git merge failed: ${m.stderr?.slice(0, 300)}`);
    return false;
  } finally {
    git('worktree', 'remove', '--force', scratch);
  }
}
function privatePath(path, directory = false) {
  const st = lstatSync(path);
  requireThat(!st.isSymbolicLink() && (directory ? st.isDirectory() : st.isFile()) && st.uid === process.getuid() && (st.mode & 0o077) === 0, 'gate state ownership/type/mode invalid');
}
function store() {
  const common = resolve(git('rev-parse', '--git-common-dir').trim());
  const path = join(common, 'agend-gate');
  try { mkdirSync(path, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  privatePath(path, true);
  return path;
}
function readPrivate(file) {
  privatePath(file);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return JSON.parse(readFileSync(fd, 'utf8')); } finally { closeSync(fd); }
}
function writePrivate(file, data) {
  const tmp = `${file}.${randomBytes(12).toString('hex')}`;
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, JSON.stringify(data)); } finally { closeSync(fd); }
  renameSync(tmp, file);
}
const marker = op => `AgEnD-Gate-Operation: ${op}`;
const operationFile = op => { requireThat(/^[a-f0-9]{48}$/.test(op), 'invalid operation'); return join(store(), `operation-${op}.json`); };

// gh pr view --json commits is commits(first:100) with no pageInfo (cli v2.74 query_builder.go).
const PR_COMMITS_QUERY = 'query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){commits(first:100,after:$cursor){totalCount pageInfo{hasNextPage endCursor} nodes{commit{messageHeadline messageBody authors(first:100){nodes{name email user{id login databaseId}}}}}}}}}';

function graphql(query, vars) {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [k, v] of Object.entries(vars)) {
    if (v == null || v === '') continue;
    args.push(typeof v === 'number' ? '-F' : '-f', `${k}=${v}`);
  }
  return gh(...args);
}

/** Every PR commit, paginated. Incomplete metadata is an error, not a silent drop. */
function allPrCommits(pr) {
  const slash = repo.indexOf('/');
  requireThat(slash > 0 && slash < repo.length - 1, 'GATE_REPO unreadable');
  const owner = repo.slice(0, slash), name = repo.slice(slash + 1);
  const commits = [];
  let cursor, total;
  for (;;) {
    const conn = graphql(PR_COMMITS_QUERY, { owner, name, number: Number(pr), cursor })?.data?.repository?.pullRequest?.commits;
    requireThat(conn && Array.isArray(conn.nodes) && Number.isInteger(conn.totalCount) && conn.totalCount >= 0, 'PR commits unreadable');
    if (total === undefined) total = conn.totalCount;
    else requireThat(conn.totalCount === total, 'PR commits unreadable');
    for (const n of conn.nodes) {
      const c = n?.commit, nodes = c?.authors?.nodes;
      requireThat(c && Array.isArray(nodes), 'PR commits unreadable');
      commits.push({
        messageHeadline: c.messageHeadline,
        messageBody: c.messageBody,
        authors: nodes.map(a => ({
          name: a?.name,
          email: a?.email,
          login: a?.user?.login,
          id: Number.isInteger(a?.user?.databaseId) ? a.user.databaseId : a?.user?.id,
        })),
      });
    }
    if (!conn.pageInfo?.hasNextPage) break;
    requireThat(typeof conn.pageInfo.endCursor === 'string' && conn.pageInfo.endCursor && commits.length < total, 'PR commits truncated');
    cursor = conn.pageInfo.endCursor;
  }
  requireThat(commits.length === total, 'PR commits truncated');
  return commits;
}

function isBotLogin(login) {
  return typeof login === 'string' && /\[bot\]$/i.test(login);
}

/** GitHub's noreply address for a PR commit author (id+login when GitHub already gave it). */
function githubNoreply(author) {
  const login = typeof author?.login === 'string' ? author.login : '';
  const email = typeof author?.email === 'string' ? author.email.trim() : '';
  if (/@users\.noreply\.github\.com$/i.test(email)) return email;
  if (Number.isInteger(author?.id) && login) return `${author.id}+${login}@users.noreply.github.com`;
  if (login) return `${login}@users.noreply.github.com`;
  return /@/.test(email) ? email : '';
}

function coAuthorLines(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^Co-authored-by:\s*(.+?)\s*<([^>]+)>\s*$/i.exec(line);
    if (m) out.push({ name: m[1].trim(), email: m[2].trim() });
  }
  return out;
}

function isMerger(login, email, me) {
  if (!me) return false;
  const mlogin = String(me.login || '').toLowerCase();
  const el = String(email || '').toLowerCase();
  if (login && mlogin && login.toLowerCase() === mlogin) return true;
  if (mlogin && el.includes(`+${mlogin}@users.noreply.github.com`)) return true;
  if (mlogin && el === `${mlogin}@users.noreply.github.com`) return true;
  if (Number.isInteger(me.id) && el.startsWith(`${me.id}+`)) return true;
  return false;
}

function trailerName(name, fallback) {
  const n = String(name || fallback || '').replace(/[\r\n<>]/g, '').trim();
  return n || 'unknown';
}

/**
 * Distinct Co-authored-by trailers for a squash: PR commit authors (GitHub noreply),
 * Co-authored-by already on those commits, then explicit Co-authored-by lines in the PR body.
 * Merger and `*[bot]` logins are omitted. Order is first-seen; emails are unique (case-insensitive).
 */
function collectCoAuthors(info, me) {
  const seen = new Set();
  const list = [];
  const add = (name, email, login) => {
    if (!email || !/@/.test(email)) return;
    if (isBotLogin(login) || /\[bot\]/i.test(name) || /\[bot\]@/i.test(email)) return;
    if (isMerger(login, email, me)) return;
    const key = email.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    list.push({ name: trailerName(name, login), email });
  };
  for (const c of Array.isArray(info.commits) ? info.commits : []) {
    for (const a of Array.isArray(c?.authors) ? c.authors : []) {
      add(a.name || a.login, githubNoreply(a), a.login);
    }
    for (const t of coAuthorLines(`${c?.messageHeadline || ''}\n${c?.messageBody || ''}`)) {
      add(t.name, t.email, null);
    }
  }
  for (const t of coAuthorLines(info.body)) add(t.name, t.email, null);
  return list;
}

function squashBody(info, op, me) {
  const trailers = collectCoAuthors(info, me).map(a => `Co-authored-by: ${a.name} <${a.email}>`);
  trailers.push(marker(op));
  const text = typeof info.body === 'string' ? info.body.replace(/\s+$/, '') : '';
  return `${text}\n\n${trailers.join('\n')}\n`;
}

function prepare(pr, head, approved, message, base) {
  requireThat(/^[1-9][0-9]*$/.test(pr) && sha(head) && sha(approved), 'invalid receipt input');
  const info = gh('pr', 'view', pr, '-R', repo, '--json', 'body');
  requireThat(info.body === undefined || typeof info.body === 'string', 'PR body unreadable');
  info.commits = allPrCommits(pr);
  const me = gh('api', 'user');
  requireThat(me && typeof me.login === 'string', 'merging identity unreadable');
  const op = randomBytes(24).toString('hex');
  const file = operationFile(op), body = join(store(), `body-${op}.txt`);
  writeFileSync(body, squashBody(info, op, me), { flag: 'wx', mode: 0o600 });
  writePrivate(file, { version: 1, kind: 'gate-squash', repo, pr: Number(pr), head, approved, message, base, op, body });
  return op;
}
function record(op, merged) {
  requireThat(sha(merged), 'merge SHA unreadable');
  const r = readPrivate(operationFile(op));
  const c = api(`commits/${merged}`);
  requireThat(c.sha === merged && c.parents?.length === 1 && sha(c.parents[0].sha) && c.commit?.message?.split('\n').includes(marker(op)), 'not this gate single-parent squash');
  const p = gh('pr', 'view', String(r.pr), '-R', repo, '--json', 'state,mergeCommit');
  requireThat(p.state === 'MERGED' && p.mergeCommit?.oid === merged, 'merge receipt mismatch');
  writePrivate(join(store(), `${merged}.json`), { ...r, merge: merged, parent: c.parents[0].sha });
  unlinkSync(r.body);
}
function mainCi(merged) {
  const d = api(`actions/runs?head_sha=${merged}&branch=main&event=push&per_page=100`);
  requireThat(Array.isArray(d.workflow_runs) && Number.isInteger(d.total_count) && d.total_count <= d.workflow_runs.length, 'main CI incomplete/unreadable');
  const relevant = d.workflow_runs.filter(r => r.head_sha === merged && r.head_branch === 'main' && r.event === 'push');
  const latest = new Map();
  for (const r of relevant) {
    requireThat(Number.isSafeInteger(r.id) && Number.isSafeInteger(r.workflow_id), 'main CI identity unreadable');
    const old = latest.get(r.workflow_id);
    if (!old || r.id > old.id || (r.id === old.id && r.run_attempt > old.run_attempt)) latest.set(r.workflow_id, r);
  }
  requireThat(latest.size, 'no exact main push CI');
  const current = [...latest.values()];
  if (current.some(r => r.status === 'completed' && r.conclusion === 'failure')) return 'FAILURE';
  if (current.some(r => r.status !== 'completed')) return 'PENDING';
  if (current.every(r => r.conclusion === 'success')) return exactCi(merged) ? 'HEALTHY' : 'PENDING';
  throw new Error('main CI is not explicit failure/success');
}
function exactCi(head) {
  const rules = api('rules/branches/main');
  requireThat(Array.isArray(rules), 'rules unreadable');
  const d = api(`commits/${head}/check-runs?per_page=100`);
  requireThat(Array.isArray(d.check_runs) && Number.isInteger(d.total_count) && d.total_count <= d.check_runs.length, 'revert CI incomplete');
  const required = new Set((process.env.GATE_REQUIRED_CHECKS ?? 'build,scan,CodeQL,Analyze (javascript-typescript),Analyze (actions)').split(',').map(s => s.trim()).filter(Boolean));
  for (const r of rules) if (r.type === 'required_status_checks') for (const c of r.parameters?.required_status_checks ?? []) if (c.context) required.add(c.context);
  const latest = new Map();
  for (const r of d.check_runs) { requireThat(typeof r.name === 'string' && Number.isSafeInteger(r.id), 'invalid check'); if (!latest.has(r.name) || latest.get(r.name).id < r.id) latest.set(r.name, r); }
  return latest.size > 0 && [...required].every(n => latest.has(n)) && [...latest.values()].every(r => r.status === 'completed' && r.conclusion === 'success');
}
function verifiedTargetCommit(r, merged, base) {
  requireThat(r.version === 1 && r.kind === 'gate-squash' && r.repo === repo && r.base === 'main' && r.merge === merged && sha(r.parent) && sha(r.head), 'not a gate main squash receipt');
  requireThat(git('rev-list', '--parents', '-n', '1', merged).trim() === `${merged} ${r.parent}`, 'not a single-parent squash');
  requireThat(git('show', '-s', '--format=%B', merged).split('\n').includes(marker(r.op)), 'gate marker mismatch');
  git('merge-base', '--is-ancestor', merged, base);
}
function verifiedTarget(r, merged, base) {
  verifiedTargetCommit(r, merged, base);
  const p = gh('pr', 'view', String(r.pr), '-R', repo, '--json', 'state,mergeCommit');
  requireThat(p.state === 'MERGED' && p.mergeCommit?.oid === merged, 'original PR receipt mismatch');
}
function readRevertPr(v) {
  const p = gh('pr', 'view', String(v.pr), '-R', repo, '--json', 'number,url,state,isDraft,headRefOid,headRefName,baseRefName,isCrossRepository,mergeCommit');
  // -R selects the base repository; the returned identity must still name that exact recorded PR.
  requireThat(p.number === v.pr && p.url === `https://github.com/${repo}/pull/${v.pr}` && p.headRefOid === v.head && p.headRefName === v.branch && p.baseRefName === 'main' && p.isCrossRepository === false, 'revert PR changed');
  requireThat(p.isDraft === false, 'revert PR is draft');
  return p;
}
function settleRevert(r, file, p) {
  requireThat(p.state === 'MERGED' && sha(p.mergeCommit?.oid), 'revert merge unconfirmed');
  r.reverted = p.mergeCommit.oid;
  writePrivate(file, r);
  return `REVERTED ${r.reverted}`;
}
function post(merged) {
  requireThat(sha(merged), 'full merge SHA required');
  const dir = store(), file = join(dir, `${merged}.json`), lock = join(dir, `lock-${merged}`);
  readPrivate(file); // Do not create a lock or branch for a non-gate commit.
  mkdirSync(lock, { mode: 0o700 });
  const mainRef = `refs/gate/post-${merged}-main`, revertRef = `refs/gate/post-${merged}-revert`;
  let scratch;
  try {
    const r = readPrivate(file); // An earlier invocation may have settled between the preflight read and this claim.
    if (r.reverted) return `REVERTED ${r.reverted}`;
    git('fetch', '-q', remote, `+refs/heads/main:${mainRef}`);
    const base = git('rev-parse', mainRef).trim();
    verifiedTarget(r, merged, base);
    const state = mainCi(merged);
    if (state !== 'FAILURE') return `${state} ${merged}`;
    if (!r.revert) {
      // Persist intent BEFORE writes. A lost answer is recovered by the exact owned branch, never a fresh proposal.
      const branch = `gate-revert/${merged}`;
      r.revert = { branch, base };
      writePrivate(file, r);
    }
    const v = r.revert;
    if (!v.head) {
      // Recover a successful push whose acknowledgement/state update was lost.
      const existing = git('ls-remote', '--heads', remote, `refs/heads/${v.branch}`).trim();
      if (existing) {
        const oid = existing.split(/\s/)[0]; requireThat(sha(oid), 'owned branch unreadable');
        git('fetch', '-q', remote, `+refs/heads/${v.branch}:${revertRef}`);
        v.head = oid;
      } else {
        scratch = join(dir, `work-${merged}`);
        git('worktree', 'add', '--detach', scratch, v.base);
        // Single explicit commit only; a conflict stops without pushing.
        run('git', ['revert', '--no-edit', merged], scratch);
        v.head = run('git', ['rev-parse', 'HEAD'], scratch).trim();
        // Record generated content before push, so a later manual branch is not adopted.
        v.tree = run('git', ['rev-parse', 'HEAD^{tree}'], scratch).trim();
        writePrivate(file, r);
        run('git', ['push', remote, `${v.head}:refs/heads/${v.branch}`], scratch);
      }
      writePrivate(file, r);
    }
    git('fetch', '-q', remote, `+refs/heads/${v.branch}:${revertRef}`);
    requireThat(git('rev-parse', revertRef).trim() === v.head && sha(v.head), 'revert branch changed');
    requireThat(v.tree && git('rev-parse', `${v.head}^{tree}`).trim() === v.tree && git('rev-list', '--parents', '-n', '1', v.head).trim() === `${v.head} ${v.base}`, 'not the recorded single revert');
    // Resume PR creation after a lost answer by looking up this exact branch.
    if (!v.pr) {
      const found = gh('pr', 'list', '-R', repo, '--state', 'all', '--head', v.branch, '--json', 'number,headRefOid,baseRefName,isCrossRepository');
      requireThat(Array.isArray(found) && found.length <= 1, 'ambiguous revert PR');
      if (found.length) { requireThat(found[0].headRefOid === v.head && found[0].baseRefName === 'main' && found[0].isCrossRepository === false, 'revert PR changed'); v.pr = found[0].number; }
      else {
        // No author review bypass for arbitrary changes: only the recorded generated revert qualifies.
        run('gh', ['pr', 'create', '-R', repo, '--base', 'main', '--head', v.branch, '--title', `Revert gate squash ${merged}`, '--body', `Automatic single-commit revert of gate PR #${r.pr}: main push CI failed at ${merged}.`]);
        const created = gh('pr', 'list', '-R', repo, '--state', 'all', '--head', v.branch, '--json', 'number,headRefOid,baseRefName,isCrossRepository');
        requireThat(created.length === 1 && created[0].headRefOid === v.head && created[0].baseRefName === 'main' && created[0].isCrossRepository === false, 'created revert PR unreadable');
        v.pr = created[0].number;
      }
      requireThat(Number.isSafeInteger(v.pr) && v.pr > 0, 'invalid revert PR');
      writePrivate(file, r);
    }
    const p = readRevertPr(v);
    if (p.state === 'MERGED') return settleRevert(r, file, p);
    requireThat(p.state === 'OPEN', 'revert PR not open');
    if (!exactCi(v.head)) return `REVERT_PENDING #${v.pr} ${v.head}`;
    // Finish the slow network reads before capturing the main tip used to authorize the effect.
    verifiedTarget(r, merged, base);
    requireThat(mainCi(merged) === 'FAILURE', 'main CI no longer failed');
    requireThat(exactCi(v.head), 'revert CI changed');
    const currentPr = readRevertPr(v);
    requireThat(currentPr.state === 'OPEN', 'revert PR not open');
    git('fetch', '-q', remote, `+refs/heads/main:${mainRef}`);
    const currentBase = git('rev-parse', mainRef).trim();
    // Local checks only after this refresh: no earlier tip survives the CI/provenance waits.
    verifiedTargetCommit(r, merged, currentBase);
    requireThat(overlap(currentBase, v.head) === 'DISJOINT', 'revert behind overlapping main: manual sync required');
    // A lost response is read back; no automatic retry here.
    let mergeError;
    try { run('gh', ['pr', 'merge', String(v.pr), '-R', repo, '--squash', '--match-head-commit', v.head]); } catch (e) { mergeError = e; }
    // The merge API pins the head, not the base. A changed destination must not settle our receipt.
    const after = readRevertPr(v);
    requireThat(after.state === 'MERGED' && sha(after.mergeCommit?.oid), `revert merge unconfirmed: ${mergeError?.message || after.state}`);
    return settleRevert(r, file, after);
  } finally {
    if (scratch) { try { git('worktree', 'remove', '--force', scratch); } catch { /* owned scratch only; operator can inspect */ } }
    try { git('update-ref', '-d', mainRef); git('update-ref', '-d', revertRef); } finally { rmSync(lock, { recursive: true }); }
  }
}
try {
  const [action, ...args] = process.argv.slice(2);
  let result;
  if (action === 'overlap') result = overlap(...args);
  else if (action === 'merge-check') result = mergeCheck(...args);
  else if (action === 'prepare') result = prepare(...args);
  else if (action === 'body') result = readPrivate(operationFile(args[0])).body;
  else if (action === 'record') { record(...args); result = 'RECORDED'; }
  else if (action === 'post') result = post(args[0]);
  else throw new Error('unknown gate action');
  console.log(result);
} catch (e) { console.log(`BLOCKED ${e.message}`); process.exitCode = 1; }
