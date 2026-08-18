# Claude Commit — notes for working on this extension

VS Code extension that shells out to the already-authenticated `claude` CLI
(never a direct API call) to: generate commit messages from the current
diff, browse commit history, and answer questions about the repo in a chat
panel. See `README.md` for the user-facing description.

## Module map

- `src/extension.ts` — activation, command registration, and the
  `claudeCommit.generate` command's flow (diff → prompt → CLI → SCM input
  box).
- `src/gitApi.ts` — resolves the built-in `vscode.git` extension's API and
  picks a repository (shared by both commands).
- `src/gitExec.ts` — single `runGit(cwd, args)` helper (execFile, no shell)
  that every git-reading module builds on.
- `src/gitDiff.ts` — diff/diffstat/recent-subjects for the commit-message
  flow.
- `src/commitHistory.ts` — paginated `git log`, per-commit detail
  (`git show --stat`/`--name-status`), and file-at-revision lookups for the
  History tab.
- `src/gitContentProvider.ts` — a `TextDocumentContentProvider` under the
  `claude-commit-git:` scheme so commit diffs open in VS Code's native diff
  editor (`vscode.diff`) instead of a custom-rendered one.
- `src/promptBuilder.ts` — builds the commit-message prompt: fixed
  instructions + diffstat + a sample of the repo's own recent commit
  subjects (so generated messages match existing style instead of always
  forcing Conventional Commits).
- `src/claudeRunner.ts` — the one place that spawns `claude`
  (`spawn(cliPath, args, { shell: false })` — keep it that way, args are an
  argv array so there's no shell-injection surface even with
  user-influenced strings like a search term).
- `src/chat.ts` — chat turns via `claude -p --output-format json`, using
  `--resume <session_id>` for multi-turn continuity instead of replaying
  the transcript each time.
- `src/hubPanel.ts` — the singleton webview panel (History + Chat tabs) and
  its message-passing router.

## The chat's tool allow-list is a safety boundary, not an implementation detail

`src/chat.ts`'s `ALLOWED_TOOLS` is deliberately read-only:
`Bash(git log:*)`, `Bash(git show:*)`, `Bash(git diff:*)`,
`Bash(git blame:*)`, `Bash(git status:*)`, `Read`, `Grep`, `Glob`. This lets
the chat genuinely explore the repo (it's the real Claude Code CLI, not
text we hand it) while making it structurally impossible for it to write,
edit, or commit anything, even if a user's question tries to talk it into
doing so — verified manually: asking it to create a file and commit it
gets refused at the tool-permission layer, not just by the model declining.
Do not widen this list to `Write`, `Edit`, `Bash(git commit:*)`,
`Bash(git push:*)`, or bare `Bash(*)`.

## Webview message protocol (`src/hubPanel.ts`)

Webview → extension: `{ type: "loadCommits", grep? }`,
`{ type: "loadMoreCommits" }`, `{ type: "getCommitDetail", hash }`,
`{ type: "viewDiff", hash, file }`, `{ type: "chatSend", text }`.

Extension → webview: `{ type: "commits", commits, hasMore, reset }`,
`{ type: "commitDetail", detail }`, `{ type: "chatMessage", role, text }`,
`{ type: "chatBusy", busy }`, `{ type: "error", message }`.

The HTML/CSS/JS is inlined as a template string in `hubPanel.ts` rather
than a separate file under `src/webview/` - `.vscodeignore` excludes
`src/**` from the packaged `.vsix`, and tsc only compiles `.ts` files, so a
separate static asset under `src/` would silently go missing from
published packages. If it's ever split out, it must live outside `src/`
(e.g. `media/`) with `.vscodeignore` updated accordingly.

## Build

```bash
npm install
npm run watch      # or: npm run compile
```

Press `F5` for an Extension Development Host. `npm run package` produces
the `.vsix` (see `PUBLISHING.md` for the marketplace release process).

There's no test suite yet - verification is manual (compile + Extension
Development Host smoke test), or by requiring the compiled `out/*.js`
modules directly from a Node script against a scratch git repo, e.g. to
check `commitHistory.ts`/`gitDiff.ts` git-plumbing logic without going
through the VS Code UI.
