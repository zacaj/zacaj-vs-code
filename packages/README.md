# packages/

Shared code used by more than one extension goes here, one npm workspace per folder
(e.g. `packages/webview-ui`), referenced from an extension's `package.json` as
`"@zacaj/<name>": "*"`. Extensions bundle with esbuild, so shared packages can be plain
TypeScript with no build step of their own.
