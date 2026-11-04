# Git Extras

Extra actions for the built-in Git Source Control view.

- **Show/hide untracked files**: an eye toggle in the Source Control view header, one button for
  all repos. It flips `git.untrackedChanges` between `hidden` and `mixed` in your global settings.
- **File context menu**: Copy Path, Copy Relative Path, Rename…, Add File to .gitignore,
  Untrack (Keep File), and Untrack and Add to .gitignore.
- **Folder context menu** (tree view): the same actions for the folder.

"Untrack" runs `git rm --cached`, so the working copy is left alone. Ignore entries are written,
anchored (`/path`), to the nearest existing `.gitignore` at or above the target, falling back to
the repo root.
