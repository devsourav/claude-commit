# Changelog

## 0.2.0

- Commit-message prompt now includes a diffstat summary and samples the
  repo's own recent commit subjects, so generated messages match the
  existing style instead of always forcing Conventional Commits, and
  reference actual changed files/functions instead of vague phrasing.
- New **Claude Commit: Open History & Chat** command opens a panel with:
  - A **History** tab to browse, search (`git log --grep`), and expand past
    commits, with a "View diff" link per changed file that opens VS Code's
    native diff editor.
  - A **Chat** tab backed by the Claude Code CLI with read-only tool access
    (`git log`/`show`/`diff`/`blame`, `Read`/`Grep`/`Glob`) so it can
    actually dig through the repo's history to answer questions, with no
    ability to write, edit, or commit anything.

## 0.1.0

- Initial release: generate a commit message from the staged (or unstaged
  fallback) diff via the Claude Code CLI, written into the SCM commit box.
