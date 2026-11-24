// scripts/run-vitest.mjs — sandbox-friendly Vitest launcher.
//
// The DSH sandbox blocks child_process spawns with pipe stdio (EPERM).
// Vite (inside Vitest) runs `exec("net use")` on Windows during its first
// realpath call; this launcher neuters child_process.exec/execFile so Vite
// falls back to fs.realpathSync. The patch only applies when
// MDT_SANDBOX=1; in normal environments Vitest runs unmodified.
//
// Usage: node scripts/run-vitest.mjs run --pool threads test
if (process.env.MDT_SANDBOX === '1') {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const cp = require('node:child_process');
  const blocked = Object.assign(new Error('child_process disabled by sandbox launcher'), {
    code: 'EPERM',
  });
  const noopChild = {
    on() {
      return noopChild;
    },
    stdout: null,
    stderr: null,
  };
  cp.exec = function fakeExec(_cmd, options, callback) {
    const cb = typeof options === 'function' ? options : callback;
    if (typeof cb === 'function') cb(blocked, '', '');
    return noopChild;
  };
  cp.execFile = function fakeExecFile(_file, _args, options, callback) {
    const cb = typeof options === 'function' ? options : callback;
    if (typeof cb === 'function') cb(blocked, '', '');
    return noopChild;
  };
}

await import('vitest/vitest.mjs');
