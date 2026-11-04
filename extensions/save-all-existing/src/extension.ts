import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('zacaj.saveAllFiles', async () => {
      await Promise.all(
        vscode.workspace.textDocuments.filter((d) => d.isDirty && !d.isUntitled && !d.isClosed).map((d) => d.save()),
      );
    }),
  );
}

export function deactivate() {}
