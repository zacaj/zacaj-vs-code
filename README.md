# zacaj-vs-code

A monorepo of VS Code extensions, built with npm workspaces.

| Path | What |
|---|---|
| [`extensions/table-viewer`](extensions/table-viewer) | Filterable, live-updating table viewer for CSV / TSV / JSON Lines |
| [`extensions/git`](extensions/git) | Extra Git SCM context-menu actions: copy path, rename, untrack, .gitignore, untracked toggle |
| [`extensions/save-all-existing`](extensions/save-all-existing) | Save all dirty files that exist on disk, skipping untitled ones |
| [`extensions/save-and-close`](extensions/save-and-close) | Save and close the active editor in one command |
| [`packages/`](packages) | Shared code for the extensions (empty for now) |

```bash
npm install          # installs every workspace
npm run build        # builds every extension
npm test
```

Each extension is bundled with esbuild into its own `out/`, so shared packages under `packages/`
can be plain TypeScript imported by workspace name. Simple extensions use the shared
`scripts/build-extension.mjs` (`src/extension.ts` → `out/extension.js`). table-viewer has its own
`esbuild.mjs` because it also builds a webview.

`npm run package -w extensions/<name>` builds one extension's `.vsix`, and `npm run package` builds
all of them.

`npm run package:combined` builds `dist/zacaj-extensions.vsix`, a single extension containing all
of them. `scripts/package-combined.mjs` merges every `contributes` section, takes the union of
activation events and dependencies, and generates an entry point that calls each extension's
`activate`. New extensions under `extensions/` are picked up automatically. The version is
`1.0.<commit count>`, so every rebuild installs as an upgrade. Install either the combined
extension or the individual ones, not both: they register the same commands. To debug, open the repo in VS Code and use
the launch configs: one per extension, plus "Run all extensions".

### Adding an extension

1. Create `extensions/<name>/` with a `package.json` (copy one from `save-and-close`), a
   `tsconfig.json` that extends `../../tsconfig.base.json`, and `src/extension.ts`.
2. Run `npm install` at the root.
3. Add a watch task and a launch config in `.vscode/`.
