import * as esbuild from 'esbuild';
import { readdirSync } from 'node:fs';

const args = new Set(process.argv.slice(2));
const production = args.has('--production');
const watch = args.has('--watch');

/** @type {esbuild.Plugin} */
const logPlugin = {
  name: 'log',
  setup(build) {
    build.onStart(() => console.log('[watch] build started'));
    build.onEnd((r) => {
      for (const e of r.errors) console.error(`✘ [ERROR] ${e.text} (${e.location?.file}:${e.location?.line})`);
      console.log('[watch] build finished');
    });
  },
};

const common = { bundle: true, sourcemap: !production, minify: production, logLevel: 'warning', plugins: [logPlugin] };

const configs = args.has('--tests')
  ? [{
      ...common,
      entryPoints: readdirSync('test').filter((f) => f.endsWith('.test.ts')).map((f) => `test/${f}`),
      outdir: 'out/test',
      platform: 'node',
      format: 'cjs',
      target: 'node18',
    }]
  : [
      {
        ...common,
        entryPoints: ['src/extension.ts'],
        outfile: 'out/extension.js',
        platform: 'node',
        format: 'cjs',
        target: 'node18',
        external: ['vscode'],
      },
      {
        ...common,
        entryPoints: { webview: 'src/webview/main.ts', 'webview-style': 'src/webview/style.css' },
        outdir: 'out',
        platform: 'browser',
        format: 'iife',
        target: 'es2022',
      },
    ];

if (watch) {
  for (const c of configs) await (await esbuild.context(c)).watch();
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
}
