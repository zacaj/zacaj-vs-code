# Table Viewer (CSV / TSV / JSON Lines)

A read-only table view for delimited and JSON Lines files, built for exploring wide, growing
files: logs, exports, traces.

## Opening files

`*.csv`, `*.tsv`, `*.tab`, `*.psv`, `*.jsonl` and `*.ndjson` files get an **Open in Table Viewer**
button in the editor title bar and the Explorer context menu. To make it the default for a type,
add this to your settings:

```jsonc
"workbench.editorAssociations": { "*.jsonl": "zacaj.tableViewer", "*.csv": "zacaj.tableViewer" }
```

**Text** in the toolbar reopens the file in the normal text editor.

## Features

- **Virtualized grid**: rows *and* columns are virtualized, so files with hundreds of columns and
  hundreds of thousands of rows scroll smoothly.
- **Live tail**: local files are watched. Appended rows stream in without re-reading the file, and
  new rows get a green marker in the row-number gutter. A partially written last line is shown
  greyed out until it's complete. If the file is truncated or rewritten, the view reloads.
  **Follow** keeps the view scrolled to the newest rows; scrolling up turns it off, and scrolling
  back to the bottom turns it on again.
- **Global search** (`Ctrl/Cmd+F`) across all columns, with match-case and regex toggles. Matches
  are highlighted.
- **Per-column filters** (the funnel icon in each header):
  - **Text**: `foo` contains, `=foo` exact, `!foo` does not contain, `/re/` regex, `""` empty, `!""` not empty.
  - **Values**: a checklist of distinct values with counts, Excel-style. Counts reflect the
    *other* active filters. You can search the list, use select all/none, and **Only these**.
    Values first seen after you set the filter stay visible unless you used "only these" or
    unchecked everything.
  - **Range** for number and date columns: min/max. Date bounds accept ISO dates, epoch
    s/ms/µs/ns, `now`, or relative offsets like `-15m`, `-2h`, `-1d`. There are also quick
    "last 5m / 1h / 24h / 7d" buttons.
  - **Column type override**: auto, string, number, date or boolean, e.g. to treat epoch
    numbers as dates.
- **Column types** are inferred: a column is numeric or date if at least 95% of its non-empty
  values parse. This drives the sort order, right-alignment and range filters. The coloured dot
  in each header shows the type.
- **Columns panel**: filter columns by name, show or hide them (all, matching, only matching,
  empty), drag to reorder, pin to the left, or click a name to jump to that column.
- **Header interactions**: click to sort (asc → desc → off), drag to reorder, drag the edge to
  resize, double-click the edge to auto-size, right-click for pin/hide/etc.
- **Row details**: double-click or press `Enter` to see every field of a row vertically. Hidden
  columns are included, JSON is pretty-printed, and you get per-field "only this" / "exclude"
  buttons. This is the easy way to read a 150-column row.
- **Cell context menu**: copy value, copy row as TSV/JSON, filter to or exclude a value, hide the
  column.
- **Keyboard**: arrows, PageUp/PageDown, Home/End, Ctrl+Home/Ctrl+End, `Ctrl+C` copies the cell.
- **Per-file layout memory**: column order, visibility, pins, widths, type overrides and sort are
  saved per file (workspace state), keyed by column name. Filters are not saved.

JSON Lines specifics: nested objects are flattened to dotted columns (`ctx.user`) up to
`tableViewer.jsonl.flattenDepth`. Arrays and deeper objects are shown as JSON. Columns are the
union of keys in order of first appearance, so new keys appearing in a live file add columns. A
line that isn't valid JSON goes to an `(unparsed)` column, and a non-object value goes to `(value)`.

## Settings

| Setting | Default | |
|---|---|---|
| `tableViewer.csv.hasHeader` | `true` | First record is column names |
| `tableViewer.csv.delimiter` | `auto` | For `.csv`: `auto` sniffs `, ; \| tab` from the first line |
| `tableViewer.jsonl.flattenDepth` | `2` | Levels of nested objects to flatten |
| `tableViewer.live` | `true` | Watch the file and stream appends |

## Architecture

```
src/extension.ts           activation, commands
src/host/provider.ts       CustomReadonlyEditor: one session per panel, file watching, batching to webview
src/host/liveReader.ts     incremental byte-offset reader (re-parses only the incomplete tail; detects truncate/rewrite)
src/host/tableBuilder.ts   text -> rows aligned to an append-only column list (CSV header / JSONL flattening)
src/host/parse.ts          stateless RFC4180 parser + JSONL line splitter + delimiter sniffing
src/shared/protocol.ts     host <-> webview message types
src/webview/model.ts       DOM-free: Table, type inference, filters, facets, sort (unit tested)
src/webview/grid.ts        virtualized grid (sticky header + pinned columns via CSS sticky)
src/webview/main.ts        UI: toolbar, filter popup, columns/details panel, menus, keyboard
```

The host parses the file and the webview owns all the rows, filtering and sorting, so filtering
never round-trips. Appends are filtered incrementally when no sort is active. With a sort active,
the view is recomputed, throttled to at most every 300 ms.

## Development

From the repo root: `npm install`, then press F5 and pick **Run Table Viewer**. Or, inside this
folder:

```bash
npm run build      # or: npm run watch
npm test           # parser / live reader / model unit tests (node:test)
npm run typecheck
npm run package    # produces a .vsix
```
