import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Format, HostMessage, Layout, WebviewMessage } from '../shared/protocol';
import { LiveReader, parseWhole, type ReadBatch } from './liveReader';
import { sniffDelimiter } from './parse';
import type { BuilderOptions } from './tableBuilder';

export const VIEW_TYPE = 'zacaj.tableViewer';
/** Cap per-message payload so the webview can render the first rows of big files quickly. */
const BATCH_CELLS = 400_000;
/** If the webview hasn't said 'ready' by then, its script most likely failed to load. */
const READY_TIMEOUT_MS = 10_000;

export class TableEditorProvider implements vscode.CustomReadonlyEditorProvider {
  static activeUri: vscode.Uri | undefined;
  private static activePanel: vscode.WebviewPanel | undefined;

  /** Send a message to the focused table viewer, if any. */
  static postToActive(m: HostMessage): boolean {
    const p = TableEditorProvider.activePanel;
    if (!p?.active) return false;
    void p.webview.postMessage(m);
    return true;
  }

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: vscode.LogOutputChannel,
  ) {}

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose() {} };
  }

  async resolveCustomEditor(doc: vscode.CustomDocument, panel: vscode.WebviewPanel): Promise<void> {
    this.log.info(`open ${doc.uri.toString(true)}`);
    let session: EditorSession;
    try {
      session = new EditorSession(this.context, doc.uri, panel, this.log);
    } catch (e) {
      this.log.error(`failed to create editor: ${(e as Error).stack ?? e}`);
      throw e;
    }
    const track = () => {
      if (panel.active) {
        TableEditorProvider.activeUri = doc.uri;
        TableEditorProvider.activePanel = panel;
      }
    };
    track();
    panel.onDidChangeViewState(track);
    panel.onDidDispose(() => session.dispose());
  }
}

function formatFor(uri: vscode.Uri): Format {
  const ext = path.extname(uri.path).toLowerCase();
  return ext === '.jsonl' || ext === '.ndjson' ? 'jsonl' : 'csv';
}

class EditorSession {
  private disposables: vscode.Disposable[] = [];
  private watchDisposables: vscode.Disposable[] = [];
  private reader: LiveReader | undefined;
  private watcher: fs.FSWatcher | undefined;
  private reading: Promise<void> | undefined;
  private rereadQueued = false;
  private debounce: NodeJS.Timeout | undefined;
  private disposed = false;
  private lastColumnCount = 0;
  private readyTimer: NodeJS.Timeout | undefined;
  private firstRead = true;
  private readonly format: Format;
  private readonly live: boolean;
  private readonly layoutKey: string;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly uri: vscode.Uri,
    private readonly panel: vscode.WebviewPanel,
    private readonly log: vscode.LogOutputChannel,
  ) {
    this.format = formatFor(uri);
    this.live = uri.scheme === 'file' && vscode.workspace.getConfiguration('tableViewer').get('live', true);
    this.layoutKey = `layout:${uri.toString()}`;
    const media = vscode.Uri.joinPath(context.extensionUri, 'out');
    panel.webview.options = { enableScripts: true, localResourceRoots: [media] };
    panel.webview.html = this.html(panel.webview, media);
    panel.webview.onDidReceiveMessage((m: WebviewMessage) => this.onMessage(m), undefined, this.disposables);
    this.readyTimer = setTimeout(() => this.notReady(), READY_TIMEOUT_MS);
  }

  private maxColumnWidth(): number {
    return Math.max(60, vscode.workspace.getConfiguration('tableViewer', this.uri).get('maxColumnWidth', 320));
  }

  private name() {
    return path.basename(this.uri.path);
  }

  private async notReady() {
    const msg = `Table Viewer: the view for ${this.name()} hasn't started after ${READY_TIMEOUT_MS / 1000}s.`;
    this.log.warn(`${msg} The webview script never sent 'ready' (failed to load or threw at startup).`);
    const pick = await vscode.window.showWarningMessage(msg, 'Open Webview DevTools', 'Show Log');
    if (pick === 'Open Webview DevTools') await vscode.commands.executeCommand('workbench.action.webview.openDeveloperTools');
    if (pick === 'Show Log') this.log.show();
  }

  private post(m: HostMessage) {
    if (!this.disposed) void this.panel.webview.postMessage(m);
  }

  private async onMessage(m: WebviewMessage) {
    switch (m.type) {
      case 'ready':
        clearTimeout(this.readyTimer);
        this.log.info(`${this.name()}: webview ready`);
        await this.start();
        break;
      case 'log':
        this.log[m.level](`${this.name()} [webview] ${m.message}`);
        break;
      case 'saveLayout':
        await this.context.workspaceState.update(this.layoutKey, m.layout);
        break;
      case 'copy':
        await vscode.env.clipboard.writeText(m.text);
        break;
      case 'openAsText':
        await vscode.commands.executeCommand('vscode.openWith', this.uri, 'default');
        break;
      case 'reload':
        this.stop();
        await this.start();
        break;
    }
  }

  private async options(): Promise<BuilderOptions> {
    const cfg = vscode.workspace.getConfiguration('tableViewer', this.uri);
    const ext = path.extname(this.uri.path).toLowerCase();
    let delimiter = ext === '.tsv' || ext === '.tab' ? '\t' : ext === '.psv' ? '|' : cfg.get<string>('csv.delimiter', 'auto');
    if (delimiter === 'auto') {
      const head = await this.readHead(8192);
      delimiter = sniffDelimiter(head);
    } else if (delimiter === '\\t' || delimiter.toLowerCase() === 'tab') delimiter = '\t';
    return {
      format: this.format,
      delimiter: delimiter || ',',
      quotes: ext === '.tsv' || ext === '.tab' ? cfg.get('tsv.quotes', false) : true,
      hasHeader: cfg.get('csv.hasHeader', true),
      flattenDepth: cfg.get('jsonl.flattenDepth', 2),
    };
  }

  private async readHead(n: number): Promise<string> {
    try {
      if (this.uri.scheme === 'file') {
        const fh = await fs.promises.open(this.uri.fsPath, 'r');
        try {
          const b = Buffer.alloc(n);
          const { bytesRead } = await fh.read(b, 0, n, 0);
          return b.subarray(0, bytesRead).toString('utf8');
        } finally {
          await fh.close();
        }
      }
      return new TextDecoder().decode((await vscode.workspace.fs.readFile(this.uri)).subarray(0, n));
    } catch {
      return '';
    }
  }

  private async start() {
    const layout = this.context.workspaceState.get<Layout>(this.layoutKey);
    this.lastColumnCount = 0;
    this.firstRead = true;
    this.post({ type: 'reset', fileName: path.basename(this.uri.path), format: this.format, live: this.live, layout, maxColumnWidth: this.maxColumnWidth() });
    try {
      const opts = await this.options();
      this.log.info(
        `${this.name()}: format=${opts.format} delimiter=${JSON.stringify(opts.delimiter)} quotes=${opts.quotes} header=${opts.hasHeader} live=${this.live} scheme=${this.uri.scheme}`,
      );
      if (this.uri.scheme === 'file') {
        this.reader = new LiveReader(this.uri.fsPath, opts);
        await this.readNow();
        if (this.live) this.watch();
      } else {
        const data = await vscode.workspace.fs.readFile(this.uri);
        const batch = parseWhole(data, opts);
        this.log.info(`${this.name()}: read ${batch.rows.length} rows, ${batch.columns.length} columns`);
        this.send(batch, true);
      }
    } catch (e) {
      this.log.error(`${this.name()}: start failed: ${(e as Error).stack ?? e}`);
      this.post({ type: 'status', message: `Failed to read file: ${(e as Error).message}`, error: true });
    }
  }

  private watch() {
    const path = this.uri.fsPath;
    const kick = () => {
      clearTimeout(this.debounce);
      this.debounce = setTimeout(() => this.schedule(), 30);
    };
    try {
      this.watcher = fs.watch(path, kick);
      this.watcher.on('error', () => undefined);
    } catch {
      /* fall back to polling only */
    }
    // fs.watch misses events on some filesystems and after rename-replace; poll as a backstop.
    const poll = () => this.schedule();
    fs.watchFile(path, { interval: 1000 }, poll);
    this.watchDisposables.push({ dispose: () => fs.unwatchFile(path, poll) });
  }

  private schedule() {
    if (this.disposed) return;
    if (this.reading) {
      this.rereadQueued = true;
      return;
    }
    void this.readNow();
  }

  private async readNow() {
    if (!this.reader) return;
    this.reading = (async () => {
      try {
        const t0 = Date.now();
        const batch = await this.reader!.read();
        if (batch) {
          this.log[this.firstRead ? 'info' : 'debug'](
            `${this.name()}: read ${batch.rows.length} rows, ${batch.columns.length} columns${batch.provisional ? ' (last provisional)' : ''}${batch.reset ? ' [reset]' : ''} in ${Date.now() - t0}ms`,
          );
          this.firstRead = false;
          this.send(batch, false);
        }
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        this.log.error(`${this.name()}: read failed: ${err.stack ?? err}`);
        this.post({ type: 'status', message: err.code === 'ENOENT' ? 'File deleted — waiting for it to reappear' : `Read error: ${err.message}`, error: true });
      }
    })();
    await this.reading;
    this.reading = undefined;
    if (this.rereadQueued) {
      this.rereadQueued = false;
      await this.readNow();
    }
  }

  private send(batch: ReadBatch, initialStatic: boolean) {
    if (batch.reset && !initialStatic) {
      const layout = this.context.workspaceState.get<Layout>(this.layoutKey);
      this.lastColumnCount = 0;
      this.post({ type: 'reset', fileName: path.basename(this.uri.path), format: this.format, live: this.live, layout, maxColumnWidth: this.maxColumnWidth() });
    }
    const { rows, columns } = batch;
    const width = Math.max(1, columns.length);
    const per = Math.max(500, Math.floor(BATCH_CELLS / width));
    let i = 0;
    do {
      const chunk = rows.slice(i, i + per);
      i += per;
      const done = i >= rows.length;
      const colsChanged = columns.length !== this.lastColumnCount;
      this.lastColumnCount = columns.length;
      this.post({
        type: 'rows',
        columns: colsChanged ? columns.slice() : undefined,
        rows: chunk,
        dropProvisional: i <= per,
        provisional: done && batch.provisional,
        done,
      });
    } while (i < rows.length);
  }

  private stop() {
    clearTimeout(this.debounce);
    this.watcher?.close();
    this.watcher = undefined;
    for (const d of this.watchDisposables.splice(0)) d.dispose();
    this.reader = undefined;
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.readyTimer);
    this.stop();
    for (const d of this.disposables.splice(0)) d.dispose();
  }

  private html(webview: vscode.Webview, media: vscode.Uri): string {
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'webview.js'));
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'webview-style.css'));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
</head>
<body>
<div id="boot" style="padding:16px;opacity:.75">Loading table viewer… If this message stays, the viewer script failed to start:
run <b>Developer: Open Webview Developer Tools</b> and check <b>Output → Table Viewer</b>.</div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}
