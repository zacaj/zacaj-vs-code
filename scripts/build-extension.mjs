// Shared esbuild script for simple extensions: bundles src/extension.ts -> out/extension.js.
// Run from an extension folder: node ../../scripts/build-extension.mjs [--watch] [--production]
import * as esbuild from 'esbuild';

const args = new Set(process.argv.slice(2));
const production = args.has('--production');

/** @type {esbuild.BuildOptions} */
const options = {
  entryPoints: ['src/extension.ts'],
  outfile: 'out/extension.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
  sourcemap: !production,
  minify: production,
  logLevel: 'warning',
  plugins: [
    {
      name: 'log',
      setup(build) {
        build.onStart(() => console.log('[watch] build started'));
        build.onEnd((r) => {
          for (const e of r.errors) console.error(`✘ [ERROR] ${e.text} (${e.location?.file}:${e.location?.line})`);
          console.log('[watch] build finished');
        });
      },
    },
  ],
};

if (args.has('--watch')) await (await esbuild.context(options)).watch();
else await esbuild.build(options);
