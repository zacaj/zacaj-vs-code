// Builds dist/zacaj-extensions.vsix: every extension in extensions/* merged into one.
// The entry point calls each extension's activate(); package.json contributions are merged.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as esbuild from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const stage = path.join(root, 'dist', 'combined');
const exts = fs.readdirSync(path.join(root, 'extensions'))
  .map((name) => ({ name, dir: path.join(root, 'extensions', name) }))
  .filter((e) => fs.existsSync(path.join(e.dir, 'package.json')))
  .map((e) => ({ ...e, pkg: JSON.parse(fs.readFileSync(path.join(e.dir, 'package.json'), 'utf8')) }));

// Arrays concatenate, objects merge recursively; `configuration` may be an object or an array.
function merge(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) return [...[a ?? []].flat(), ...[b ?? []].flat()];
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = k === 'configuration' ? merge([a[k] ?? []].flat(), [v]) : merge(a[k], v);
    return out;
  }
  return b ?? a;
}

execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' });
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(path.join(stage, 'out'), { recursive: true });

// Non-entry build outputs (e.g. table-viewer's webview bundle) are resolved via
// context.extensionUri/out/..., so copy them next to the combined entry point.
for (const e of exts) {
  const out = path.join(e.dir, 'out');
  for (const f of fs.existsSync(out) ? fs.readdirSync(out, { withFileTypes: true }) : []) {
    if (f.isFile() && f.name !== 'extension.js' && !f.name.endsWith('.map')) fs.copyFileSync(path.join(out, f.name), path.join(stage, 'out', f.name));
  }
}

const ids = exts.map((_, i) => `e${i}`);
await esbuild.build({
  stdin: {
    resolveDir: root,
    contents: [
      ...exts.map((e, i) => `import * as ${ids[i]} from ${JSON.stringify(path.join(e.dir, 'src', 'extension.ts'))};`),
      `const all = [${ids.join(', ')}];`,
      `export function activate(ctx) { for (const e of all) e.activate?.(ctx); }`,
      `export function deactivate() { return Promise.all(all.map((e) => e.deactivate?.())); }`,
    ].join('\n'),
  },
  outfile: path.join(stage, 'out', 'extension.js'),
  bundle: true, platform: 'node', format: 'cjs', target: 'node18', external: ['vscode'], minify: true,
});

const maxEngine = exts.map((e) => e.pkg.engines.vscode).sort((a, b) =>
  a.replace(/\D*/, '').localeCompare(b.replace(/\D*/, ''), undefined, { numeric: true })).at(-1);
const uniq = (xs) => [...new Set(xs)];
let commits = '0';
try { commits = execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); } catch {}

const pkg = {
  name: 'zacaj-extensions',
  displayName: "zacaj's extensions",
  description: `All-in-one: ${exts.map((e) => e.pkg.displayName ?? e.pkg.name).join(', ')}`,
  version: `1.0.${commits}`,
  publisher: 'zacaj',
  license: 'MIT',
  repository: { type: 'git', url: 'https://github.com/zacaj/zacaj-vs-code' },
  engines: { vscode: maxEngine },
  categories: ['Other'],
  main: './out/extension.js',
  activationEvents: uniq(exts.flatMap((e) => e.pkg.activationEvents ?? [])),
  extensionDependencies: uniq(exts.flatMap((e) => e.pkg.extensionDependencies ?? [])),
  contributes: exts.reduce((acc, e) => merge(acc, e.pkg.contributes ?? {}), {}),
};
fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify(pkg, null, 2));
fs.writeFileSync(path.join(stage, 'README.md'), `# ${pkg.displayName}\n\n${exts.map((e) =>
  `- **${e.pkg.displayName ?? e.pkg.name}**: ${e.pkg.description ?? ''}`).join('\n')}\n\nDon't install alongside the individual extensions (duplicate commands).\n`);

const vsix = path.join(root, 'dist', 'zacaj-extensions.vsix');
execFileSync(path.join(root, 'node_modules', '.bin', 'vsce'), ['package', '--no-dependencies', '--skip-license', '--out', vsix], { cwd: stage, stdio: 'inherit' });
