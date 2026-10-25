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
- `src/chat.ts` — the History chat (`askChat`: `claude -p --output-format
  json`, with `--resume <session_id>` between turns) and the Team Pool
  chat's persistent `ChatProcess` (see Token budget).
- `src/hubPanel.ts` — the webview panel (History + Chat tabs) and its
  message-passing router. `createOrShow` reveals the most recently used
  panel (switching its repo if needed); the editor-title "+" button
  (`claudeCommit.openHubNewTab`) always opens another, independent one, like
  clicking Claude Code's own icon. Saved conversations are merged by id on
  write (`saveConversations`), not overwritten, so two tabs open on the same
  repo don't clobber each other's history.
- `src/pool.ts` — the team memory pool's on-disk format under
  `.claude-pool/` (markdown entries with a tiny frontmatter, generated
  `index.md`, raw `sources/`), plus the `@.claude-pool/index.md` CLAUDE.md
  link that makes every teammate's Claude Code load it.
- `src/poolIngest.ts` — turns sources into entry bodies: Swagger/OpenAPI
  is rendered deterministically (no model), docs/links/Figma go through
  `claude -p` with a per-source tool list (`Read` / `WebFetch` /
  `claudeCommit.pool.figmaTools`).
- `src/poolPanel.ts` — the "Team Pool" webview (Chat / Pool / Add tabs),
  opened beside the editor from the `editor/title` menu. Its chat uses
  `streamChat` in `chat.ts` (`stream-json` + `--include-partial-messages`),
  with permission modes and approvals (see below). It also expands
  `@path#L10-20` references and the current editor selection into the
  prompt. Like `hubPanel.ts`, `createOrShow` reveals the most recently used
  tab and the editor-title "+" (`claudeCommit.openPoolNewTab`) always opens
  another; each panel instance owns its own `PermissionBroker` (see below)
  and conversation saves merge by id, for the same reason.
- `src/poolWebview.ts` — the Team Pool webview's HTML/CSS/JS, laid out
  like the Claude Code panel (conversation header, turn timeline with tool
  rows, numbered permission prompt, composer with `+` / `/` / model+effort
  pill / Shift+Tab mode switcher / mic). The mic uses OS dictation, because
  VS Code webviews can't access the microphone and Claude Code's own speech
  service isn't available to other extensions. Uses inline SVG icons, never
  Anthropic's logo or mascot.
- `src/permissionBroker.ts` / `src/permissionServer.ts` — the approval
  channel between the CLI and the panel. Each `PoolPanel` instance owns its
  own `PermissionBroker` (own loopback port + token), constructed in the
  panel's own constructor and disposed with it - never shared across tabs,
  since a shared single-handler broker would let one tab's running turn
  silently steal or drop another concurrently-running tab's approval
  requests. `permissionServer.ts` runs as a separate process spawned by
  `claude`, never inside the extension host.
- `src/proposedChanges.ts` — the in-memory `claude-commit-proposed:`
  documents behind an approval card's "View diff".
- `src/safety.ts` / `src/safetyHook.ts` — safety rules checked before
  every file change and command (see below). `safetyHook.ts` is a
  `PreToolUse` hook process the CLI runs; `pool.ts` calls `findSecret`
  directly before writing entries or copying sources.

## Token budget

A bare `claude -p` carries ~33k input tokens of Claude Code scaffolding
(every built-in tool schema, skills, MCP connectors). Every call site trims
that, measured with CLI 2.1:
- Commit message: `--system-prompt` + `--tools ""` + `LEAN_ARGS` +
  `--effort low` → ~1k tokens plus the repo's CLAUDE.md. The diff skips
  lockfiles, minified files and maps (`NOISY_PATHSPECS`, still in
  `--stat`) and uses `--unified=1`.
- Chats: `--tools` with only the tools each mode needs (~13-14k; ~22k in
  a repo with a big CLAUDE.md). Read-only chats also use `LEAN_ARGS`. Edit
  modes keep MCP plus `ToolSearch`. Removing `ToolSearch` makes it worse,
  because deferred tools then load in full.
- Team Pool chat runs **one long-lived process per conversation**
  (`ChatProcess` in `chat.ts`, `--input-format stream-json`), not a fresh
  `claude -p --resume` per message. A resumed process re-sends history that
  doesn't byte-match the cached prefix, so its first request re-wrote the
  whole conversation at cache-write price on nearly every message
  (measured: turn 2 wrote 29k vs 104 tokens with a persistent process).
  Interrupt, permission mode and model change live over control requests.
  Only effort, module focus, and read-only ↔ edit restart the process
  (`chatProcessKey`). It shuts down after 20 min idle.
- Auto-compact (`claudeCommit.pool.autoCompactTokens`, default 100k): with
  1M-context models, Claude Code's own auto-compact effectively never
  fires, and every step of a turn re-sends the whole context. The panel
  sends `/compact` right after a turn that crossed the threshold, while
  the cache is warm.
- Pasted images go inline as image blocks (no extra `Read` request), and
  the system prompt asks Claude to Grep first and Read line ranges.
- Ingestion: exactly one built-in tool per source type.
- `.claude-pool/index.md` is loaded into every teammate's context, so it
  stays one capped line per entry; full entries are read on demand.
Don't use `--bare` (it disables OAuth/subscription auth). When adding a
`claude -p` call, always pass `toolsArg(...)`.

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

That rule covers the History tab's chat. The **Team Pool** chat
(`poolPanel.ts`) is different, by an explicit product decision: it can edit
files and run commands like Claude Code, but only through a human approval
gate. `ALLOWED_TOOLS` stays pre-approved. Every other tool call goes through
`--permission-prompt-tool mcp__claude_commit__approve`:
`out/permissionServer.js` (a stdio MCP server the CLI spawns) forwards it
over a token-checked loopback socket to `PermissionBroker`, and the panel
shows an Allow / Allow for session / Deny card (with a native "View diff"
for Edit/Write via `proposedChanges.ts`). Modes map to `--permission-mode`:
`ask` (default, no flag), `acceptEdits`, `auto`, `plan`, plus `readonly`
(no prompt tool, the original boundary). Rules to keep:
- Never pass `bypassPermissions` / `--dangerously-skip-permissions`, and
  never auto-allow anything in the broker that the user didn't approve.
- Keep the token out of argv (it's passed via env, which the MCP server
  inherits) and the server bound to 127.0.0.1.
- A Deny without feedback must keep `interrupt: true`, so the turn stops
  instead of Claude retrying the same action.
- Every edit-mode turn passes the `safetyHook.js` `PreToolUse` hook via
  `--settings`. It's the only check that runs in `acceptEdits`/`auto`,
  where the CLI never calls the approval tool for edits. `deny` blocks
  edits outside the repo or inside `.git/`, edits writing credentials,
  invalid JSON, edits to the generated pool index, and destructive
  commands (force push, `reset --hard`, `curl | sh`, `sudo`...). `ask`
  forces the approval card even in auto modes, for sensitive files
  (`.env`, keys, CI, lockfiles, `.claude/settings`), large shrinking
  rewrites, and `git commit`/`push`. "Allow for this session" never
  covers an `ask` verdict. Keep rules high-confidence: noisy rules train
  people to click through.

Ingestion runs get exactly one capability each (`Read`, `WebFetch`, or the
configured Figma *read* tools). Keep `pool.figmaTools` to read tools,
because newer Figma MCP servers also expose tools that write to the Figma
file.

## Webview message protocol (`src/hubPanel.ts`)

Webview → extension: `{ type: "loadCommits", grep? }`,
`{ type: "loadMoreCommits" }`, `{ type: "getCommitDetail", hash }`,
`{ type: "viewDiff", hash, file }`, `{ type: "chatSend", text }`.

Extension → webview: `{ type: "commits", commits, hasMore, reset }`,
`{ type: "commitDetail", detail }`, `{ type: "chatMessage", role, text }`,
`{ type: "chatBusy", busy }`, `{ type: "error", message }`.

Team Pool (`src/poolPanel.ts` ↔ `src/poolWebview.ts`) webview → extension: `ready`,
`{ chatSend, text, includeSelection, images }`, `chatStop`, `{ setPermissionMode, mode }`,
`{ openConversation, id }`, `{ deleteConversation, id }`, `{ setEffort, effort }`,
`focusEditor`, `{ pickAttachment, images }`, `{ removeAttachment, path }`,
`{ approvalResponse, id, decision, reason }`, `{ viewProposedDiff, id }`,
`{ openFile, path, line? }`, `{ fileSearch, query }`, `chatNew`, `{ setModuleFocus, module }`,
`{ setModel, model }`, `{ saveToPool, text }`, `loadPool`,
`{ openEntry, path }`, `{ deleteEntry, path }`, `linkClaudeMd`, `openScm`,
`{ pickFiles, purpose }`, `{ ingestPreview, kind, files, urls, focus }`,
`{ saveEntry, kind, module, release, title, summary, body, files, urls }`.
Extension → webview: `init`, `conversations`, `chatReset` (a whole
conversation), `chatItem` (user/tool/notice row), `chatDelta`,
`chatToolResult`, `chatMeta` (model, slash commands, context tokens,
lastTurnAt), `attachmentAdded`, `focusInput`, `approvalRequest`, `approvalResolved`, `editorContext`, `insertText`,
`fileResults`,
`chatDone`, `chatBusy`, `pool`, `pickedFiles`, `ingestBusy`,
`ingestPreview`, `ingestError`, `saved`, `error`. Conversations persist
as `ChatItem[]` (the same shape that's streamed), so restored and live
turns render identically. The webview script is a `String.raw` literal (so regex backslashes survive), which means it must
not contain backticks or `${`.

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
