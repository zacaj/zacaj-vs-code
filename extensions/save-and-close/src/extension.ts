import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('save-and-close-editor.saveAndCloseActiveEditor', async () => {
      if (vscode.window.activeTextEditor?.document.isDirty) await vscode.commands.executeCommand('workbench.action.files.save');
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    }),
  );
}

export function deactivate() {}
