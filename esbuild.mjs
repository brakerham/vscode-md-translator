// Build script for the Markdown AI Translator extension.
// Uses the esbuild JS API; falls back to spawning the platform binary with
// inherited stdio if the JS API cannot spawn its service process (e.g. inside
// sandboxes that forbid pipe-based child processes).
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');

const entries = [
  { entry: 'src/extension.ts', out: 'dist/extension.js', platform: 'node', format: 'cjs', external: ['vscode'] },
  { entry: 'src/webview/main.ts', out: 'dist/media/main.js', platform: 'browser', format: 'iife' },
  { entry: 'src/webview/mermaid.ts', out: 'dist/media/mermaid.js', platform: 'browser', format: 'iife', minify: true, define: { global: 'globalThis' } },
  { entry: 'src/sidebar/sidebarScript.ts', out: 'dist/media/sidebar.js', platform: 'browser', format: 'iife' },
];

const watchContexts = [];
const watchChildren = [];
const bundleInputs = new Set();

function cliArgsFor(e) {
  const args = [e.entry, `--outfile=${e.out}`, '--bundle', `--platform=${e.platform}`, `--format=${e.format}`];
  if (e.external) { for (const x of e.external) args.push(`--external:${x}`); }
  if (e.minify) args.push('--minify');
  if (e.define) { for (const [k, v] of Object.entries(e.define)) args.push(`--define:${k}=${v}`); }
  args.push('--target=es2022', '--charset=utf8', '--sourcemap', '--log-level=info');
  if (watch) args.push('--watch');
  else args.push('--metafile=' + e.out + '.build.json');
  return args;
}

function platformBinaryPath() {
  const mapping = {
    'win32-x64': '@esbuild/win32-x64/esbuild.exe',
    'win32-arm64': '@esbuild/win32-arm64/esbuild.exe',
    'win32-ia32': '@esbuild/win32-ia32/esbuild.exe',
    'darwin-x64': '@esbuild/darwin-x64/bin/esbuild',
    'darwin-arm64': '@esbuild/darwin-arm64/bin/esbuild',
    'linux-x64': '@esbuild/linux-x64/bin/esbuild',
    'linux-arm64': '@esbuild/linux-arm64/bin/esbuild',
    'linux-arm': '@esbuild/linux-arm/bin/esbuild',
    'linux-ia32': '@esbuild/linux-ia32/bin/esbuild',
  };
  const key = `${process.platform}-${process.arch}`;
  const rel = mapping[key];
  if (!rel) throw new Error(`No esbuild binary mapping for ${key}`);
  const direct = resolve(root, 'node_modules', rel);
  if (existsSync(direct)) return direct;
  try {
    return require.resolve(rel);
  } catch {
    throw new Error(`Cannot locate esbuild binary for ${key}`);
  }
}

async function buildWithApi(esbuild) {
  for (const e of entries) {
    const opts = {
      entryPoints: [e.entry],
      outfile: e.out,
      bundle: true,
      platform: e.platform,
      format: e.format,
      target: ['es2022'],
      sourcemap: watch ? 'inline' : true,
      logLevel: 'info',
      charset: 'utf8',
    };
    if (e.external) opts.external = e.external;
    if (e.minify) opts.minify = true;
    if (e.define) opts.define = e.define;
    if (watch) {
      const ctx = await esbuild.context(opts);
      await ctx.watch();
      console.log(`[watch] ${e.entry}`);
      watchContexts.push(ctx);
    } else {
      const result = await esbuild.build({ ...opts, metafile: true });
      for (const input of Object.keys(result.metafile.inputs)) bundleInputs.add(input);
    }
  }
}

async function buildWithBinary() {
  const bin = platformBinaryPath();
  for (const e of entries) {
    if (watch) {
      const child = spawn(bin, cliArgsFor(e), { stdio: 'inherit' });
      watchChildren.push(child);
      child.on('exit', (code) => {
        if (code) console.error(`[esbuild] ${e.entry} exited with ${code}`);
      });
    } else {
      const res = spawnSync(bin, cliArgsFor(e), { stdio: 'inherit' });
      if (res.status !== 0) throw new Error(`esbuild failed for ${e.entry}: status ${res.status}`);
      const metadata = JSON.parse(readFileSync(e.out + '.build.json', 'utf8'));
      for (const input of Object.keys(metadata.inputs)) bundleInputs.add(input);
    }
  }
}

function copyAssets() {
  const rootNode = join(root, 'node_modules');
  const media = join(root, 'dist', 'media');
  const copy = (from, to) => {
    if (existsSync(from)) {
      cpSync(from, to, { recursive: true });
      console.log(`[assets] ${from} -> ${to}`);
    } else {
      throw new Error(`Missing required asset: ${from}`);
    }
  };
  copy(join(root, 'media', 'preview.css'), join(media, 'preview.css'));
  copy(join(root, 'media', 'sidebar.css'), join(media, 'sidebar.css'));
  copy(join(rootNode, 'katex', 'dist', 'katex.min.css'), join(media, 'katex', 'katex.min.css'));
  copy(join(rootNode, 'katex', 'dist', 'fonts'), join(media, 'katex', 'fonts'));
  copy(join(rootNode, '@vscode', 'codicons', 'dist', 'codicon.css'), join(media, 'codicons', 'codicon.css'));
  copy(join(rootNode, '@vscode', 'codicons', 'dist', 'codicon.ttf'), join(media, 'codicons', 'codicon.ttf'));
}

function writeThirdPartyNotices() {
  const packages = new Set(['node_modules/@vscode/codicons', 'node_modules/katex']);
  for (const input of bundleInputs) {
    const parts = input.replaceAll('\\', '/').split('/');
    const modulesIndex = parts.lastIndexOf('node_modules');
    if (modulesIndex < 0) continue;
    const nameParts = parts[modulesIndex + 1].startsWith('@') ? 2 : 1;
    packages.add(parts.slice(0, modulesIndex + nameParts + 1).join('/'));
  }
  const notices = ['Third-party notices for bundled code and assets.'];
  for (const directory of [...packages].sort()) {
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    const title = manifest.name + ' ' + manifest.version + ' (' + (manifest.license ?? 'See license text') + ')';
    const files = readdirSync(directory)
      .filter((file) => /^(licen[cs]e|unlicense|notice|copying)([.-]|$)/i.test(file))
      .sort()
      .map((file) => join(directory, file));
    // Some npm archives omit their upstream repository's license.
    const fallback = typeof manifest.repository === 'string' &&
      manifest.repository.startsWith('https://github.com/micromark/micromark/tree/main/packages/')
      ? 'micromark-3.2.0.txt'
      : manifest.name + '-' + manifest.version + '.txt';
    const upstream = join(root, 'licenses', fallback);
    if (!files.length && existsSync(upstream)) files.push(upstream);
    if (!files.length) throw new Error('Missing license text in ' + directory);
    const texts = files.map((file) => readFileSync(file, 'utf8').trim());
    notices.push([title, ...texts].join('\n\n'));
  }
  writeFileSync(join(root, 'dist', 'THIRD-PARTY-NOTICES.txt'), notices.join('\n\n' + '-'.repeat(72) + '\n\n') + '\n');
}

async function main() {
  mkdirSync(join(root, 'dist', 'media'), { recursive: true });
  try {
    const esbuild = await import('esbuild');
    await buildWithApi(esbuild);
  } catch (err) {
    const msg = String((err && err.message) || err);
    console.warn(`[build] esbuild JS API unavailable (${msg}); falling back to platform binary`);
    for (const ctx of watchContexts) {
      try { await ctx.dispose(); } catch { /* ignore */ }
    }
    await buildWithBinary();
    copyAssets();
    if (!watch) writeThirdPartyNotices();
    if (watch) console.log('[build] watching with platform binary...');
    return;
  }
  copyAssets();
  if (!watch) writeThirdPartyNotices();
  if (watch) console.log('[build] watching... (Ctrl+C to stop)');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
