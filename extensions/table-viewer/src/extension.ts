import * as vscode from 'vscode';
import { TableEditorProvider, VIEW_TYPE } from './host/provider';

export function activate(context: vscode.ExtensionContext) {
  const log = vscode.window.createOutputChannel('Table Viewer', { log: true });
  context.subscriptions.push(
    log,
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, new TableEditorProvider(context, log), {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: true,
    }),
    vscode.commands.registerCommand('tableViewer.open', (uri?: vscode.Uri) => {
      uri ??= vscode.window.activeTextEditor?.document.uri;
      if (uri) return vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
    }),
    vscode.commands.registerCommand('tableViewer.goToColumn', () => {
      TableEditorProvider.postToActive({ type: 'focusColumnSearch' });
    }),
    vscode.commands.registerCommand('tableViewer.openAsText', (uri?: vscode.Uri) => {
      uri ??= TableEditorProvider.activeUri;
      if (uri) return vscode.commands.executeCommand('vscode.openWith', uri, 'default');
    }),
  );
}

export function deactivate() {}
