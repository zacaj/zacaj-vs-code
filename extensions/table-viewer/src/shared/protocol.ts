// Messages exchanged between the extension host and the webview.

export type Format = 'csv' | 'jsonl';
export type ColType = 'string' | 'number' | 'date' | 'boolean';

/** Per-file view layout, persisted by the host (keyed by column name so it survives schema changes). */
export interface Layout {
  order?: string[];
  hidden?: string[];
  pinned?: string[];
  widths?: Record<string, number>;
  types?: Record<string, ColType>;
  sort?: { column: string; dir: 1 | -1 };
}

export type HostMessage =
  | { type: 'reset'; fileName: string; format: Format; live: boolean; layout?: Layout; maxColumnWidth: number }
  | {
      type: 'rows';
      /** Full column list; only sent when it changed. Columns are only ever appended. */
      columns?: string[];
      rows: string[][];
      /** Remove the webview's current provisional row before appending these. */
      dropProvisional: boolean;
      /** The last row in `rows` is an incomplete trailing record that may be replaced later. */
      provisional: boolean;
      /** Final batch of the current read. */
      done: boolean;
    }
  | { type: 'status'; message: string; error?: boolean };

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'saveLayout'; layout: Layout }
  | { type: 'copy'; text: string }
  | { type: 'openAsText' }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'reload' };
