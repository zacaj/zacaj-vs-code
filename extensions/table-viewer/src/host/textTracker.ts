import * as vscode from 'vscode';

/** Where the user was in a text editor when they left it. */
export interface TextSnapshot {
  uri: string;
  document: vscode.TextDocument;
  /** Cursor (selection.active). */
  cursor: vscode.Position;
  /** First and last visible lines. */
  visible: [number, number];
  time: number;
}

/**
 * Tracks the active text editor's cursor and scroll position, and reports a snapshot when the user
 * switches away from it, so a table viewer for the same file can jump to the corresponding cell.
 */
export class TextTracker implements vscode.Disposable {
  private current: TextSnapshot | undefined;
  last: TextSnapshot | undefined;
  private readonly emitter = new vscode.EventEmitter<TextSnapshot>();
  readonly onDidLeave = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.capture(vscode.window.activeTextEditor);
    this.disposables.push(
      this.emitter,
      vscode.window.onDidChangeActiveTextEditor((e) => {
        if (this.current && this.current.document !== e?.document) {
          this.last = { ...this.current, time: Date.now() };
          this.emitter.fire(this.last);
        }
        this.capture(e);
      }),
      vscode.window.onDidChangeTextEditorSelection((e) => e.textEditor === vscode.window.activeTextEditor && this.capture(e.textEditor)),
      vscode.window.onDidChangeTextEditorVisibleRanges((e) => e.textEditor === vscode.window.activeTextEditor && this.capture(e.textEditor)),
    );
  }

  private capture(e: vscode.TextEditor | undefined) {
    if (!e || e.document.uri.scheme === 'output') {
      this.current = undefined;
      return;
    }
    const vr = e.visibleRanges;
    this.current = {
      uri: e.document.uri.toString(),
      document: e.document,
      cursor: e.selection.active,
      visible: vr.length ? [vr[0].start.line, vr[vr.length - 1].end.line] : [e.selection.active.line, e.selection.active.line],
      time: Date.now(),
    };
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
  }
}
