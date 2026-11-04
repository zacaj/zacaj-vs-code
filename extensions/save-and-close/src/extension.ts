import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
	let disposable = vscode.commands.registerCommand('save-and-close-editor.saveAndCloseActiveEditor', async () => {
    if (vscode.window.activeTextEditor?.document.isDirty)
			await vscode.commands.executeCommand("workbench.action.files.save");
    vscode.commands.executeCommand("workbench.action.closeActiveEditor");
	});

	context.subscriptions.push(disposable);
}

// This method is called when your extension is deactivated
export function deactivate() {}
