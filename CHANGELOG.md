# Changelog

## 0.2.11

- History tab: each commit row now shows a small leading dot - filled for
  a regular commit, a hollow ring for a merge commit - matching VS Code's
  own git graph bullet style, without drawing the connecting branch
  lines.

## 0.2.10

- Fixed the sidebar collapse/expand button overlapping the rightmost chat
  bubble: it was absolutely-positioned floating over the chat log, which
  could collide with right-aligned user messages. Replaced with a single
  always-present slim toggle handle that's a real flex sibling of the
  chat log and sidebar, so it reserves its own space and can't overlap
  anything.

## 0.2.9

- Chat now supports multiple saved conversations per repository (like
  ChatGPT/Claude.ai), not just one continuous thread: a collapsible
  sidebar on the right lists all past conversations (title + last-updated
  time), searchable by title, click one to reopen it, "+ New chat" starts
  a fresh thread. Each conversation keeps its own Claude Code CLI session
  id for continuity. Existing single-thread history from 0.2.8 is
  migrated in automatically as each repo's first conversation.

## 0.2.8

- Chat history now persists per repository across panel reopens and VS
  Code restarts (last 200 turns, plus the Claude Code CLI session id for
  continuity) - reopening the panel or switching back to a repo picks the
  conversation up where it left off instead of starting empty every time.

## 0.2.7

- The Repository selector only ever listed repos already open in the
  current VS Code workspace (a `vscode.git` API limitation, not a
  filter). Added a "Browse for repository..." action always shown at the
  bottom of the dropdown - opens a folder picker, validates it has a
  `.git`, and switches to it. Repos opened this way are remembered across
  panel reopens.

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
