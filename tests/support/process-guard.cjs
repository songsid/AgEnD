/* Test-only OS boundary. Native hooks survive vi.restoreAllMocks and local
 * child_process mocks. Preloaded in Node children, including built-CLI probes.
 * This is an accident guard, not a sandbox for adversarial test programs. */
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { syncBuiltinESMExports } = require('node:module');
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
function resolveExecutable(file, env) {
  if (file.includes('/')) return path.resolve(file);
  for (const dir of (env.PATH || '').split(path.delimiter)) {
    const candidate = path.join(dir, file);
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch {}
  }
  return file;
}
function fixtureAllowed(file, env) {
  try {
    const entries = JSON.parse(process.env.AGEND_TEST_EXECUTABLE_FIXTURES || '{}');
    const real = fs.realpathSync(resolveExecutable(file, env));
    const digest = entries[real];
    return typeof digest === 'string' && fs.statSync(real).isFile()
      && crypto.createHash('sha256').update(fs.readFileSync(real)).digest('hex') === digest;
  } catch { return false; }
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
  return !relative.startsWith('..') && /^(?:agend-|agtkw)[^/]+\//.test(relative)
    && !relative.split('/').includes('default');
}
function checkShell(command, env) {
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
    checkInvocation(word, end < 0 ? rest : rest.slice(0, end), env);
    start = false;
  }
}
function checkInvocation(file, argv = [], env = process.env) {
  const base = path.basename(String(file));
  if (BACKENDS.has(base) && !fixtureAllowed(file, env)) throw new Error(`real backend CLI forbidden: ${base}`);
  if (base === 'tmux') {
    if (!privateSocket(argv, env)) throw new Error('tmux requires a private test socket (-L/-S)');
    // Check commands launched in panes; a private socket does not authorise a
    // vendor CLI. send-keys can launch one too.
    for (const arg of argv) if (typeof arg === 'string') checkShell(arg, env);
  }
  if (SHELLS.has(base)) {
    const c = argv.findIndex(arg => /^-[^-]*c[^-]*$/.test(arg));
    if (c !== -1 && typeof argv[c + 1] === 'string') checkShell(argv[c + 1], env);
  }
  if (/^node(?:js)?$/.test(base) && !argv.some(arg => ['-e', '--eval', '-p', '--print'].includes(arg))) {
    const script = argv.find(arg => !arg.startsWith('-') && (BACKENDS.has(path.basename(arg).replace(/\.(?:m?js|cjs|exe)$/, ''))
      || /(?:@openai[\/]codex|@anthropic-ai[\/]claude-code|[\/]kiro-cli[\/]).*\.(?:m?js|cjs)$/.test(arg)));
    if (script && !fixtureAllowed(script, env)) throw new Error(`real backend Node entry forbidden: ${path.basename(script)}`);
  }
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
  function guard(file, argv, env) {
    try { checkInvocation(file, argv, env); } catch (cause) { reject(cause); }
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
    guard(options.file, options.args.slice(1), env);
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
      if (shellCall) {
        try { checkShell(String(file), options.env || process.env); } catch (cause) {
          reject(cause);
        }
      } else if (options.shell) {
        try { checkShell([file, ...argv].join(' '), options.env || process.env); } catch (cause) { reject(cause); }
      } else guard(file, argv, options.env || process.env);
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
  state.takeViolations = () => {
    const local = state.violations.splice(0);
    const log = process.env.AGEND_TEST_GUARD_LOG;
    if (!log || !fs.existsSync(log)) return local;
    const recorded = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
    fs.writeFileSync(log, '');
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
module.exports = { install, checkInvocation, scrubEnvironment, privateSocket };
install();
