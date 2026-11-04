import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';

const execFileP = promisify(execFile);

/** The slice of the built-in git extension's API (vscode.git, API v1) that we use. */
interface GitRepository {
  rootUri: vscode.Uri;
  status(): Promise<void>;
}
interface GitAPI {
  getRepository(uri: vscode.Uri): GitRepository | null;
}
interface GitExtension {
  getAPI(version: 1): GitAPI;
}

/** SCM context-menu commands receive resource states (possibly nested arrays for multi-select). */
type ScmResource = { resourceUri?: vscode.Uri } | undefined;
type ScmArg = ScmResource | ScmResource[];

function sync() {
  const v = vscode.workspace.getConfiguration('git').get('untrackedChanges');
  void vscode.commands.executeCommand('setContext', 'untrackedHidden', v === 'hidden');
}

const urisOf = (args: ScmArg[]): vscode.Uri[] =>
  args.flat().map((r) => r?.resourceUri).filter((u): u is vscode.Uri => !!u);

// deepest common directory of all files under the clicked node
function commonDir(uris: vscode.Uri[]): string {
  let common = path.dirname(uris[0].fsPath).split(path.sep);
  for (const u of uris.slice(1)) {
    const parts = path.dirname(u.fsPath).split(path.sep);
    let i = 0;
    while (i < common.length && common[i] === parts[i]) i++;
    common = common.slice(0, i);
  }
  return common.join(path.sep);
}

// files menu: each selected file; folder menu: the folder itself
function targets(args: ScmArg[], isFolder: boolean): vscode.Uri[] {
  const uris = urisOf(args);
  if (!uris.length) return [];
  if (isFolder) return [vscode.Uri.file(commonDir(uris))];
  return [...new Map(uris.map((u) => [u.toString(), u])).values()];
}

async function copyPaths(args: ScmArg[], isFolder: boolean, isRelative: boolean) {
  const list = targets(args, isFolder);
  if (!list.length) return;
  const text = list.map((u) => (isRelative ? vscode.workspace.asRelativePath(u, false) : u.fsPath)).join('\n');
  await vscode.env.clipboard.writeText(text);
}

async function rename(args: ScmArg[], isFolder: boolean) {
  const [uri] = targets(args, isFolder);
  if (!uri) return;
  const base = path.basename(uri.fsPath);
  const ext = isFolder ? '' : path.extname(base);
  const name = await vscode.window.showInputBox({
    prompt: `Rename ${isFolder ? 'folder' : 'file'}`,
    value: base,
    valueSelection: [0, base.length - ext.length],
    validateInput: (v) =>
      !v.trim()
        ? 'Name required'
        : /[\\/]/.test(v)
          ? 'Name cannot contain slashes'
          : v !== base && fs.existsSync(path.join(path.dirname(uri.fsPath), v))
            ? `${v} already exists`
            : null,
  });
  if (!name || name === base) return;
  const edit = new vscode.WorkspaceEdit();
  edit.renameFile(uri, vscode.Uri.file(path.join(path.dirname(uri.fsPath), name)));
  if (!(await vscode.workspace.applyEdit(edit))) void vscode.window.showErrorMessage(`Failed to rename ${base}`);
}

function repoFor(uri: vscode.Uri): GitRepository | undefined {
  const git = vscode.extensions.getExtension<GitExtension>('vscode.git')?.exports.getAPI(1);
  const repo = git?.getRepository(uri) ?? undefined;
  if (!repo) void vscode.window.showWarningMessage('No git repository found for that path.');
  return repo;
}

const relTo = (root: string, p: string) => path.relative(root, p).split(path.sep).join('/');

function appendIgnore(dir: string, lines: string[]) {
  const gi = path.join(dir, '.gitignore');
  const existing = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
  const have = new Set(existing.split(/\r?\n/));
  const add = [...new Set(lines)].filter((l) => !have.has(l));
  if (!add.length) return;
  const sep = existing && !existing.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(gi, sep + add.map((l) => l + '\n').join(''));
}

// nearest .gitignore at or above the target's parent dir (falls back to repo root)
function ignoreDirFor(root: string, p: string): string {
  let dir = path.dirname(p);
  while (dir.startsWith(root + path.sep)) {
    if (fs.existsSync(path.join(dir, '.gitignore'))) return dir;
    dir = path.dirname(dir);
  }
  return root;
}

// write each path, anchored, into its nearest .gitignore
function ignorePaths(root: string, paths: string[], isFolder: boolean) {
  const byDir = new Map<string, string[]>();
  for (const p of paths) {
    const dir = ignoreDirFor(root, p);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir)!.push(`/${relTo(dir, p)}${isFolder ? '/' : ''}`);
  }
  for (const [dir, lines] of byDir) appendIgnore(dir, lines);
}

async function gitignore(args: ScmArg[], isFolder: boolean) {
  const list = targets(args, isFolder);
  if (!list.length) return;
  const repo = repoFor(list[0]);
  if (!repo) return;
  const root = repo.rootUri.fsPath;
  const rels = list.map((u) => relTo(root, u.fsPath));
  if (rels.includes('')) return void vscode.window.showWarningMessage('That is the repo root.');
  ignorePaths(root, list.map((u) => u.fsPath), isFolder);
}

// git rm --cached: stop tracking, leave the working copy alone
async function untrack(args: ScmArg[], isFolder: boolean, shouldIgnore: boolean) {
  const list = targets(args, isFolder);
  if (!list.length) return;
  const repo = repoFor(list[0]);
  if (!repo) return;
  const root = repo.rootUri.fsPath;
  const rels = list.map((u) => relTo(root, u.fsPath));
  if (rels.includes('')) return void vscode.window.showWarningMessage('That is the repo root.');
  try {
    await execFileP('git', ['rm', '--cached', '-q', ...(isFolder ? ['-r'] : []), '--', ...rels], { cwd: root });
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    return void vscode.window.showErrorMessage(`git rm --cached failed: ${err.stderr || err.message}`);
  }
  if (shouldIgnore) ignorePaths(root, list.map((u) => u.fsPath), isFolder);
  await repo.status();
}

export function activate(ctx: vscode.ExtensionContext) {
  const set = (v: string) =>
    vscode.workspace.getConfiguration('git').update('untrackedChanges', v, vscode.ConfigurationTarget.Global);
  const cmd = (id: string, fn: (args: ScmArg[]) => unknown) =>
    vscode.commands.registerCommand(id, (...a: ScmArg[]) => fn(a));
  ctx.subscriptions.push(
    vscode.commands.registerCommand('toggleUntracked.hide', () => set('hidden')),
    vscode.commands.registerCommand('toggleUntracked.show', () => set('mixed')),
    cmd('gitignoreFolder.add', (a) => gitignore(a, true)),
    cmd('zacajGit.gitignoreFile', (a) => gitignore(a, false)),
    cmd('zacajGit.copyPath', (a) => copyPaths(a, false, false)),
    cmd('zacajGit.copyRelativePath', (a) => copyPaths(a, false, true)),
    cmd('zacajGit.rename', (a) => rename(a, false)),
    cmd('zacajGit.copyFolderPath', (a) => copyPaths(a, true, false)),
    cmd('zacajGit.copyFolderRelativePath', (a) => copyPaths(a, true, true)),
    cmd('zacajGit.renameFolder', (a) => rename(a, true)),
    cmd('zacajGit.untrack', (a) => untrack(a, false, false)),
    cmd('zacajGit.untrackIgnore', (a) => untrack(a, false, true)),
    cmd('zacajGit.untrackFolder', (a) => untrack(a, true, false)),
    cmd('zacajGit.untrackIgnoreFolder', (a) => untrack(a, true, true)),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('git.untrackedChanges') && sync()),
  );
  sync();
}

export function deactivate() {}
