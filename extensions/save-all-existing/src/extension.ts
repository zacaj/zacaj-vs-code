import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
	let disposable = vscode.commands.registerCommand('zacaj.saveAllFiles', async () => {
		await Promise.all(vscode.workspace.textDocuments.filter(editor => editor.isDirty && !editor.isUntitled && !editor.isClosed).map(editor => editor.save()))
	});

	context.subscriptions.push(disposable);
}

// This method is called when your extension is deactivated
export function deactivate() {}
