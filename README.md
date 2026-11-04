# zacaj-vs-code

A monorepo of VS Code extensions, built with npm workspaces.

| Path | What |
|---|---|
| [`extensions/table-viewer`](extensions/table-viewer) | Filterable, live-updating table viewer for CSV / TSV / JSON Lines |
| [`packages/`](packages) | Shared code for the extensions (empty for now) |

```bash
npm install          # installs every workspace
npm run build        # builds every extension
npm test
```

Each extension is bundled with esbuild into its own `out/`, so shared packages under `packages/`
can be plain TypeScript imported by workspace name. To debug, open the repo in VS Code and use the
launch configs in `.vscode/launch.json`.
