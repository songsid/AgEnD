// Child-CLI health fixture: no server or panes, including its version probe.
const cp = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');
for (const name of ['spawnSync', 'execFileSync']) {
  const original = cp[name];
  cp[name] = function(file, ...args) {
    if (file !== 'tmux') return original.call(this, file, ...args);
    if (name === 'spawnSync') return { status: 1, stdout: '', stderr: 'no fixture server' };
    throw new Error('no fixture server');
  };
}
const originalExecFile = cp.execFile;
cp.execFile = (file, ...args) => {
  if (file !== 'tmux') return originalExecFile(file, ...args);
  const callback = args.findLast(arg => typeof arg === 'function');
  queueMicrotask(() => callback?.(new Error('no fixture server'), '', ''));
  return { stdin: { on() {}, end() {} } };
};
cp.execFile[require('node:util').promisify.custom] = (file, ...args) => new Promise((resolve, reject) => {
  cp.execFile(file, ...args, (err, stdout, stderr) => err ? reject(err) : resolve({ stdout, stderr }));
});
syncBuiltinESMExports();
