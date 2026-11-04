const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const execFileP = require('util').promisify(require('child_process').execFile);

function sync() {
  const v = vscode.workspace.getConfiguration('git').get('untrackedChanges');
  vscode.commands.executeCommand('setContext', 'untrackedHidden', v === 'hidden');
}

const urisOf = (args) => args.flat().map(r => r?.resourceUri).filter(Boolean);

// deepest common directory of all files under the clicked node
function commonDir(uris) {
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
function targets(args, isFolder) {
  const uris = urisOf(args);
  if (!uris.length) return [];
  if (isFolder) return [vscode.Uri.file(commonDir(uris))];
  return [...new Map(uris.map(u => [u.toString(), u])).values()];
}

async function copyPaths(args, isFolder, isRelative) {
  const list = targets(args, isFolder);
  if (!list.length) return;
  const text = list.map(u => isRelative ? vscode.workspace.asRelativePath(u, false) : u.fsPath).join('\n');
  await vscode.env.clipboard.writeText(text);
}

async function rename(args, isFolder) {
  const [uri] = targets(args, isFolder);
  if (!uri) return;
  const base = path.basename(uri.fsPath);
  const ext = isFolder ? '' : path.extname(base);
  const name = await vscode.window.showInputBox({
    prompt: `Rename ${isFolder ? 'folder' : 'file'}`,
    value: base,
    valueSelection: [0, base.length - ext.length],
    validateInput: v => !v.trim() ? 'Name required'
      : /[\\/]/.test(v) ? 'Name cannot contain slashes'
      : v !== base && fs.existsSync(path.join(path.dirname(uri.fsPath), v)) ? `${v} already exists` : null,
  });
  if (!name || name === base) return;
  const edit = new vscode.WorkspaceEdit();
  edit.renameFile(uri, vscode.Uri.file(path.join(path.dirname(uri.fsPath), name)));
  if (!await vscode.workspace.applyEdit(edit)) vscode.window.showErrorMessage(`Failed to rename ${base}`);
}

function repoFor(uri) {
  const git = vscode.extensions.getExtension('vscode.git')?.exports.getAPI(1);
  const repo = git?.getRepository(uri);
  if (!repo) vscode.window.showWarningMessage('No git repository found for that path.');
  return repo;
}

const relTo = (root, p) => path.relative(root, p).split(path.sep).join('/');

function appendIgnore(dir, lines) {
  const gi = path.join(dir, '.gitignore');
  const existing = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
  const have = new Set(existing.split(/\r?\n/));
  const add = [...new Set(lines)].filter(l => !have.has(l));
  if (!add.length) return;
  const sep = existing && !existing.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(gi, sep + add.map(l => l + '\n').join(''));
}

// nearest .gitignore at or above the target's parent dir (falls back to repo root)
function ignoreDirFor(root, p) {
  let dir = path.dirname(p);
  while (dir.startsWith(root + path.sep)) {
    if (fs.existsSync(path.join(dir, '.gitignore'))) return dir;
    dir = path.dirname(dir);
  }
  return root;
}

// write each path, anchored, into its nearest .gitignore
function ignorePaths(root, paths, isFolder) {
  const byDir = new Map();
  for (const p of paths) {
    const dir = ignoreDirFor(root, p);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(`/${relTo(dir, p)}${isFolder ? '/' : ''}`);
  }
  for (const [dir, lines] of byDir) appendIgnore(dir, lines);
}

async function gitignore(args, isFolder) {
  const list = targets(args, isFolder);
  if (!list.length) return;
  const repo = repoFor(list[0]);
  if (!repo) return;
  const root = repo.rootUri.fsPath;
  const rels = list.map(u => relTo(root, u.fsPath));
  if (rels.includes('')) return vscode.window.showWarningMessage('That is the repo root.');
  ignorePaths(root, list.map(u => u.fsPath), isFolder);
}

// git rm --cached: stop tracking, leave the working copy alone
async function untrack(args, isFolder, shouldIgnore) {
  const list = targets(args, isFolder);
  if (!list.length) return;
  const repo = repoFor(list[0]);
  if (!repo) return;
  const root = repo.rootUri.fsPath;
  const rels = list.map(u => relTo(root, u.fsPath));
  if (rels.includes('')) return vscode.window.showWarningMessage('That is the repo root.');
  try {
    await execFileP('git', ['rm', '--cached', '-q', ...(isFolder ? ['-r'] : []), '--', ...rels], { cwd: root });
  } catch (e) {
    return vscode.window.showErrorMessage(`git rm --cached failed: ${e.stderr || e.message}`);
  }
  if (shouldIgnore) ignorePaths(root, list.map(u => u.fsPath), isFolder);
  await repo.status();
}

exports.activate = (ctx) => {
  const set = (v) => vscode.workspace.getConfiguration('git')
    .update('untrackedChanges', v, vscode.ConfigurationTarget.Global);
  ctx.subscriptions.push(
    vscode.commands.registerCommand('toggleUntracked.hide', () => set('hidden')),
    vscode.commands.registerCommand('toggleUntracked.show', () => set('mixed')),
    vscode.commands.registerCommand('gitignoreFolder.add', (...a) => gitignore(a, true)),
    vscode.commands.registerCommand('zacajGit.gitignoreFile', (...a) => gitignore(a, false)),
    vscode.commands.registerCommand('zacajGit.copyPath', (...a) => copyPaths(a, false, false)),
    vscode.commands.registerCommand('zacajGit.copyRelativePath', (...a) => copyPaths(a, false, true)),
    vscode.commands.registerCommand('zacajGit.rename', (...a) => rename(a, false)),
    vscode.commands.registerCommand('zacajGit.copyFolderPath', (...a) => copyPaths(a, true, false)),
    vscode.commands.registerCommand('zacajGit.copyFolderRelativePath', (...a) => copyPaths(a, true, true)),
    vscode.commands.registerCommand('zacajGit.renameFolder', (...a) => rename(a, true)),
    vscode.commands.registerCommand('zacajGit.untrack', (...a) => untrack(a, false, false)),
    vscode.commands.registerCommand('zacajGit.untrackIgnore', (...a) => untrack(a, false, true)),
    vscode.commands.registerCommand('zacajGit.untrackFolder', (...a) => untrack(a, true, false)),
    vscode.commands.registerCommand('zacajGit.untrackIgnoreFolder', (...a) => untrack(a, true, true)),
    vscode.workspace.onDidChangeConfiguration(e => e.affectsConfiguration('git.untrackedChanges') && sync())
  );
  sync();
};
