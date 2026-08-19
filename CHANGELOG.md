# Changelog

## 0.2.6

- Reverted the chat-rendering changes from 0.2.3-0.2.5 back to the 0.2.2
  behavior at the user's request (0.2.2 was confirmed working for them,
  the later changes were not). This brings back the known raw
  `**`/backtick markdown display in chat replies, and drops the
  try/catch hardening around `loadRepositories()` and the webview's
  message-handling switch. Revisit if markdown rendering or History-tab
  robustness need another pass.

## 0.2.5

- Fixed the History tab going completely blank (no repo/branch/author
  populated, no commits, no "No commits found" fallback either): a throw
  in the extension-side `loadRepositories()` - which ran before
  `loadCommits`/`loadBranches`/`loadAuthors` in the panel's setup - could
  silently abort all of them. It's now wrapped like the other loaders.
- Replaced the removed blanket error listener with a precisely-scoped one:
  the webview's own message-handling switch is now wrapped in try/catch,
  so a bug in handling a specific message type shows up as "Failed
  handling '<type>': ..." in the History tab's own error banner - clearly
  attributable to this extension, unlike a page-wide listener, and it
  doesn't stop later messages from being handled normally.

## 0.2.4

- Removed the blanket page-wide error listener added in 0.2.3 for
  debugging - it was too broad and could surface unrelated errors from
  other scripts sharing the webview as if they were bugs in this
  extension.

## 0.2.3

- Fixed chat markdown rendering under webview hosts that enforce Trusted
  Types (which silently rejects `innerHTML` assignment): bold/code
  formatting is now built with real DOM nodes instead of an HTML string,
  which is what was actually causing replies to either go blank or show
  raw `**`/backtick markdown depending on which fallback path was active.

## 0.2.2

- History tab: added a searchable repository selector next to the branch
  selector, for multi-root workspaces - switching repository resets the
  history filters and starts a fresh chat session (previous session's
  context doesn't leak across repos).

## 0.2.1

- History tab: branch switcher and author filter are now searchable
  comboboxes (not plain dropdowns/free text), file-change counts show as
  `+A/~M/-D` badges per commit (and colored per-file status letters when
  expanded), search now also matches by commit hash, added author/date-range
  filters, and infinite scroll replaces the old "Load more" button.
- Fixed the History/Chat tab strip and filters bar losing their sticky
  positioning after scrolling past one screenful.
- Chat tab: input box is pinned to the bottom with only the message log
  scrolling, replies render basic markdown (bold, inline code) instead of
  showing raw `**`/backticks, and auto-scroll now respects manual scrolling
  and resumes once you stop.

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
