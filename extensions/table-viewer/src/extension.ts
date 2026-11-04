import * as vscode from 'vscode';
import { TableEditorProvider, VIEW_TYPE } from './host/provider';

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, new TableEditorProvider(context), {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: true,
    }),
    vscode.commands.registerCommand('tableViewer.open', (uri?: vscode.Uri) => {
      uri ??= vscode.window.activeTextEditor?.document.uri;
      if (uri) return vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
    }),
    vscode.commands.registerCommand('tableViewer.openAsText', (uri?: vscode.Uri) => {
      uri ??= TableEditorProvider.activeUri;
      if (uri) return vscode.commands.executeCommand('vscode.openWith', uri, 'default');
    }),
  );
}

export function deactivate() {}
