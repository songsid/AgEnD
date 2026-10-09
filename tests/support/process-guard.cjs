/* Test-only OS boundary. Native hooks survive vi.restoreAllMocks and local
 * child_process mocks. Preloaded in Node children, including built-CLI probes.
 * This is an accident guard, not a sandbox for adversarial test programs. */
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { syncBuiltinESMExports } = require('node:module');
const { fileURLToPath } = require('node:url');
const KEY = Symbol.for('agend.test.process-guard');
const BACKENDS = new Set(['claude', 'codex', 'kiro-cli', 'grok', 'muse', 'agy', 'opencode', 'gemini']);
const SHELLS = new Set(['sh', 'bash', 'dash', 'zsh', 'fish']);

function scrubEnvironment(env) {
  for (const key of Object.keys(env)) {
    if (/(?:_TOKEN$|_BOT_)/i.test(key)) delete env[key];
  }
}
function tokens(text) {
  // Shell words with quoting, separators, and escaped characters. Expansion is
  // not evaluated. Node descendants receive the same native hooks below.
  return (text.match(/(?:[^\s;'"|&<>]+|"(?:\\.|[^"\\])*"|'[^']*')+|[;|&\n]/g) || [])
    .map(word => word.replace(/(['"])(.*?)\1/g, '$2').replace(/\\(.)/g, '$1'));
}
function childCwd(cwd) {
  if (cwd == null) return process.cwd();
  return path.resolve(cwd instanceof URL ? fileURLToPath(cwd) : Buffer.isBuffer(cwd) ? cwd.toString() : cwd);
}
function resolveExecutable(file, env, cwd) {
  if (file.includes('/')) return path.resolve(cwd, file);
  // Without an explicit PATH, native lookup may use an OS default. Never
  // substitute a pinned file in the parent's cwd for that unknown executable.
  if (typeof env.PATH !== 'string') return null;
  for (const dir of env.PATH.split(path.delimiter)) {
    const candidate = path.resolve(cwd, dir || '.', file);
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch {}
  }
  return null;
}
function fixtureAllowed(file, env, cwd, script = false) {
  try {
    const entries = JSON.parse(process.env.AGEND_TEST_EXECUTABLE_FIXTURES || '{}');
    const real = fs.realpathSync(script ? path.resolve(cwd, file) : resolveExecutable(file, env, cwd));
    const digest = entries[real];
    return typeof digest === 'string' && fs.statSync(real).isFile()
      && crypto.createHash('sha256').update(fs.readFileSync(real)).digest('hex') === digest;
  } catch { return false; }
}
function canonicalFuturePath(file) {
  let current = path.resolve(file);
  const missing = [];
  for (;;) {
    try { return path.join(fs.realpathSync(current), ...missing.reverse()); }
    catch (error) {
      if (error.code !== 'ENOENT') return null;
      // A dangling symlink is an unresolved alias, not a future private path.
      try { fs.lstatSync(current); return null; }
      catch (statError) { if (statError.code !== 'ENOENT') return null; }
      const parent = path.dirname(current);
      if (parent === current) return null;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}
function privateSocket(argv, env = process.env) {
  // -L must name a test server, never AgEnD's production hashed socket. -S
  // must be below a private temporary fixture directory, not tmux-UID/default.
  const names = [], sockets = [];
  for (let i = 0; i < argv.length && argv[i].startsWith('-'); i++) {
    const arg = argv[i];
    if (arg === '-L') names.push(argv[++i]);
    else if (arg.startsWith('-L')) names.push(arg.slice(2));
    else if (arg === '-S') sockets.push(argv[++i]);
    else if (arg.startsWith('-S')) sockets.push(arg.slice(2));
    else if (['-f', '-T'].includes(arg)) i++;
    else if (arg === '--') break;
  }
  if (names.length + sockets.length !== 1) return false;
  if (names.length) {
    if (/^(?:agend-test-|agend-term-|agend-1125-|agtkw\d|agend-vitest-)/.test(names[0] || '')) return true;
    const home = env.AGEND_HOME;
    if (!home || !path.isAbsolute(home)) return false;
    const rel = path.relative(os.tmpdir(), home);
    return !rel.startsWith('..') && /^agend-[^/]+(?:\/|$)/.test(rel)
      && names[0] === `agend-${crypto.createHash('sha256').update(home).digest('hex').slice(0, 6)}`;
  }
  const socket = sockets[0];
  if (!socket || !path.isAbsolute(socket)) return false;
  const relative = path.relative(os.tmpdir(), path.resolve(socket));
  if (relative.startsWith('..') || !/^(?:agend-|agtkw)[^/]+\//.test(relative)
      || relative.split('/').includes('default')) return false;
  // Resolve existing socket/parents without contacting tmux. A future socket
  // is valid, but aliases inside its fixture cannot escape to another server.
  const canonical = canonicalFuturePath(socket);
  try { return canonical === path.join(fs.realpathSync(os.tmpdir()), relative); }
  catch { return false; }
}
function checkShell(command, env, cwd) {
  const words = tokens(command);
  let start = true;
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (/^[;|&\n]$/.test(word)) { start = true; continue; }
    if (!start) continue;
    if (/^[\w]+=.*/.test(word)) continue;
    if (word === 'exec' && words[i + 1] === '-a') { i += 2; continue; }
    if (word === 'timeout') { while (words[i + 1]?.startsWith('-')) i++; i++; continue; }
    if (['exec', 'env', 'command', 'nohup', 'sudo'].includes(word) || word.startsWith('-')) continue;
    // command -v and which inspect PATH; they do not execute a backend.
    if (word === 'which' || (words[i - 1] === '-v' || words[i - 1] === '-V')) { start = false; continue; }
    const rest = words.slice(i + 1);
    const end = rest.findIndex(w => /^[;|&\n]$/.test(w));
    checkInvocation(word, end < 0 ? rest : rest.slice(0, end), env, cwd);
    start = false;
  }
}
function checkInvocation(file, argv = [], env = process.env, cwd = process.cwd()) {
  cwd = childCwd(cwd);
  const base = path.basename(String(file));
  if (BACKENDS.has(base) && !fixtureAllowed(file, env, cwd)) throw new Error(`real backend CLI forbidden: ${base}`);
  // Through PATH (`sh -c "agend fleet start"`), an `agend` that is not a registered fixture is whatever is installed on
  // this host — a real fleet. A harness that once stubbed `agend` on PATH must not be the only thing in the way.
  if (base === 'agend' && argv[0] === 'fleet' && argv[1] === 'start' && !fixtureAllowed(file, env, cwd)) {
    throw new Error('a real `agend fleet start` from a test is forbidden');
  }
  if (base === 'tmux') {
    if (!privateSocket(argv, env)) throw new Error('tmux requires a private test socket (-L/-S)');
    // Check commands launched in panes; a private socket does not authorise a
    // vendor CLI. send-keys can launch one too.
    for (const arg of argv) if (typeof arg === 'string') checkShell(arg, env, cwd);
  }
  if (SHELLS.has(base)) {
    const c = argv.findIndex(arg => /^-[^-]*c[^-]*$/.test(arg));
    if (c !== -1 && typeof argv[c + 1] === 'string') checkShell(argv[c + 1], env, cwd);
  }
  if (/^node(?:js)?$/.test(base) && !argv.some(arg => ['-e', '--eval', '-p', '--print'].includes(arg))) {
    const script = argv.find(arg => !arg.startsWith('-') && (BACKENDS.has(path.basename(arg).replace(/\.(?:m?js|cjs|exe)$/, ''))
      || /(?:@openai[\/]codex|@anthropic-ai[\/]claude-code|[\/]kiro-cli[\/]).*\.(?:m?js|cjs)$/.test(arg)));
    if (script && !fixtureAllowed(script, env, cwd, true)) throw new Error(`real backend Node entry forbidden: ${path.basename(script)}`);
  }
}
// #1450 C5: AgEnD restarts itself as `<this Node> <package>/dist/cli.js fleet start` (src/cli.ts from source) — no
// `agend` on PATH a test could stub. A test may never start a real fleet (the daemon) that way, from this repo or any
// copy of it; one that means to observe it sets AGEND_TEST_SELF_SPAWN_LOG, and the spawn is recorded there and
// replaced by an inert `sh -c 'exit 0'`.
function isAgendCli(file) {
  if (!/^cli\.(?:js|ts)$/.test(path.basename(file))) return false;
  try { return JSON.parse(fs.readFileSync(path.join(path.dirname(file), '..', 'package.json'), 'utf8')).name === '@songsid/agend'; }
  catch { return false; }
}
function selfFleetStart(file, argv, cwd) {
  if (!/^node(?:js)?$/.test(path.basename(String(file)))) return null;
  const i = argv.findIndex(arg => typeof arg === 'string' && !arg.startsWith('-') && isAgendCli(path.resolve(childCwd(cwd), arg)));
  const rest = i < 0 ? [] : argv.slice(i + 1);
  return rest[0] === 'fleet' && rest[1] === 'start' ? rest.join(' ') : null;
}
function install() {
  if (globalThis[KEY]) return globalThis[KEY];
  const state = { violations: [] };
  function reject(cause) {
      const error = new Error(`[test process guard] ${cause.message}`);
      state.violations.push(error.message);
      if (process.env.AGEND_TEST_GUARD_TRACE) process.stderr.write(`${error.stack}\n`);
      if (process.env.AGEND_TEST_GUARD_LOG) fs.appendFileSync(process.env.AGEND_TEST_GUARD_LOG, `${error.message}\n`);
      throw error; // before ANY native spawn, even if the caller catches it
  }
  function guard(file, argv, env, cwd) {
    try { checkInvocation(file, argv, env, cwd); } catch (cause) { reject(cause); }
  }
  function childEnv(env) {
    const result = { ...(env || process.env) };
    // A test may intentionally clear NODE_OPTIONS for a warning probe. Keep
    // its other choices, but never remove the isolation preload from children.
    const preload = `--require=${JSON.stringify(__filename)}`;
    if (!(result.NODE_OPTIONS || '').includes(__filename)) result.NODE_OPTIONS = `${result.NODE_OPTIONS || ''} ${preload}`.trim();
    result.AGEND_TEST_GUARD_LOG = process.env.AGEND_TEST_GUARD_LOG || '';
    result.AGEND_TEST_EXECUTABLE_FIXTURES = process.env.AGEND_TEST_EXECUTABLE_FIXTURES || '{}';
    return result;
  }
  const originalSpawn = cp.ChildProcess.prototype.spawn;
  cp.ChildProcess.prototype.spawn = function(options) {
    const env = Object.fromEntries((options.envPairs || []).map(pair => { const i = pair.indexOf('='); return [pair.slice(0, i), pair.slice(i + 1)]; }));
    guard(options.file, options.args.slice(1), env, options.cwd);
    const self = selfFleetStart(options.file, options.args.slice(1), options.cwd);
    if (self) {
      const log = env.AGEND_TEST_SELF_SPAWN_LOG || process.env.AGEND_TEST_SELF_SPAWN_LOG;
      if (!log) reject(new Error(`a real \`agend ${self}\` from a test is forbidden (set AGEND_TEST_SELF_SPAWN_LOG to record it instead)`));
      fs.appendFileSync(log, `agend ${self}\n`);
      options.file = '/bin/sh';
      options.args = ['sh', '-c', 'exit 0'];
    }
    options.envPairs = Object.entries(childEnv(env)).map(([key, value]) => `${key}=${value}`);
    return originalSpawn.call(this, options);
  };
  for (const name of ['execSync', 'execFileSync', 'spawnSync']) {
    const original = cp[name];
    cp[name] = function(file, argv, options) {
      const shellCall = name === 'execSync';
      if (shellCall) { options = argv || {}; argv = []; }
      else if (!Array.isArray(argv)) { options = argv || {}; argv = []; }
      options = options || {};
      const env = options.env || process.env;
      const cwd = childCwd(options.cwd);
      if (shellCall || options.shell) {
        const shell = typeof options.shell === 'string' ? options.shell
          : process.platform === 'win32' ? env.ComSpec || process.env.ComSpec || 'cmd.exe' : '/bin/sh';
        guard(shell, [], env, cwd); // options.shell is itself an executable
        try { checkShell(shellCall ? String(file) : [file, ...argv].join(' '), env, cwd); }
        catch (cause) { reject(cause); }
      } else guard(file, argv, env, cwd);
      const guardedOptions = { ...options, env: childEnv(options.env) };
      return shellCall ? original.call(this, file, guardedOptions) : original.call(this, file, argv, guardedOptions);
    };
  }
  // Native probe workers have a separate JS realm. Preload there too, even
  // when a caller supplies execArgv (for example stripping tsx loader flags).
  const threads = require('node:worker_threads');
  const OriginalWorker = threads.Worker;
  threads.Worker = class GuardedWorker extends OriginalWorker {
    constructor(file, options = {}) {
      const execArgv = [...(options.execArgv || process.execArgv)];
      if (!execArgv.some(arg => arg.includes(__filename))) execArgv.push(`--require=${__filename}`);
      const env = options.env === threads.SHARE_ENV ? options.env : childEnv(options.env);
      super(file, { ...options, execArgv, env });
    }
  };
  syncBuiltinESMExports();
  let drainSequence = 0;
  state.drainJournal = log => {
    if (!log || !fs.existsSync(log)) return [];
    const bytes = fs.readFileSync(log);
    const cursorPath = `${log}.cursor`;
    let cursor = 0;
    try {
      const saved = Number(fs.readFileSync(cursorPath, 'utf8'));
      if (Number.isSafeInteger(saved) && saved >= 0 && saved <= bytes.length) cursor = saved;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const end = bytes.lastIndexOf(10) + 1;
    if (end <= cursor) return [];
    const recorded = bytes.subarray(cursor, end).toString('utf8').split('\n').filter(Boolean);
    // Journals stay append-only. Persist only the boundary we actually read,
    // so an append during the drain remains visible to the next drain/teardown.
    // Atomic replacement prevents readers from seeing a partial cursor value.
    const temporary = `${cursorPath}.${process.pid}-${threads.threadId}-${++drainSequence}`;
    fs.writeFileSync(temporary, String(end), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, cursorPath);
    return recorded;
  };
  state.takeViolations = () => {
    const local = state.violations.splice(0);
    const recorded = state.drainJournal(process.env.AGEND_TEST_GUARD_LOG);
    return recorded.length ? recorded : local;
  };
  state.registerFixture = file => {
    const real = fs.realpathSync(file);
    const rel = path.relative(os.tmpdir(), real);
    if (rel.startsWith('..') || !rel.includes(path.sep) || !fs.statSync(real).isFile()) throw new Error('executable fixture must be a private temporary file');
    const entries = JSON.parse(process.env.AGEND_TEST_EXECUTABLE_FIXTURES || '{}');
    entries[real] = crypto.createHash('sha256').update(fs.readFileSync(real)).digest('hex');
    process.env.AGEND_TEST_EXECUTABLE_FIXTURES = JSON.stringify(entries);
  };
  globalThis[KEY] = state;
  return state;
}
module.exports = { selfFleetStart, install, checkInvocation, scrubEnvironment, privateSocket };
install();
