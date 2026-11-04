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

export class TableEditorProvider implements vscode.CustomReadonlyEditorProvider {
  static activeUri: vscode.Uri | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose() {} };
  }

  async resolveCustomEditor(doc: vscode.CustomDocument, panel: vscode.WebviewPanel): Promise<void> {
    const session = new EditorSession(this.context, doc.uri, panel);
    const track = () => {
      if (panel.active) TableEditorProvider.activeUri = doc.uri;
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
  private readonly format: Format;
  private readonly live: boolean;
  private readonly layoutKey: string;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly uri: vscode.Uri,
    private readonly panel: vscode.WebviewPanel,
  ) {
    this.format = formatFor(uri);
    this.live = uri.scheme === 'file' && vscode.workspace.getConfiguration('tableViewer').get('live', true);
    this.layoutKey = `layout:${uri.toString()}`;
    const media = vscode.Uri.joinPath(context.extensionUri, 'out');
    panel.webview.options = { enableScripts: true, localResourceRoots: [media] };
    panel.webview.html = this.html(panel.webview, media);
    panel.webview.onDidReceiveMessage((m: WebviewMessage) => this.onMessage(m), undefined, this.disposables);
  }

  private post(m: HostMessage) {
    if (!this.disposed) void this.panel.webview.postMessage(m);
  }

  private async onMessage(m: WebviewMessage) {
    switch (m.type) {
      case 'ready':
        await this.start();
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
    this.post({ type: 'reset', fileName: path.basename(this.uri.path), format: this.format, live: this.live, layout });
    const opts = await this.options();
    try {
      if (this.uri.scheme === 'file') {
        this.reader = new LiveReader(this.uri.fsPath, opts);
        await this.readNow();
        if (this.live) this.watch();
      } else {
        const data = await vscode.workspace.fs.readFile(this.uri);
        this.send(parseWhole(data, opts), true);
      }
    } catch (e) {
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
        const batch = await this.reader!.read();
        if (batch) this.send(batch, false);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
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
      this.post({ type: 'reset', fileName: path.basename(this.uri.path), format: this.format, live: this.live, layout });
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
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}
