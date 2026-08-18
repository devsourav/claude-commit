# Claude Commit

Generate a git commit message from your current diff, browse your commit
history, and chat about your repo's past — all written by the
[Claude Code CLI](https://docs.claude.com/en/docs/claude-code) — without
leaving VS Code.

It works in any VS Code-based editor that supports `.vsix` sideloading and
ships the built-in Git extension (`vscode.git`), including **Cursor** and
**Antigravity**, since it's a standard extension built only on stable,
non-proprietary VS Code APIs.

## What it does

1. You stage some changes (`git add`) — or don't; unstaged changes are used
   as a fallback.
2. Click the sparkle (✨) icon in the Source Control panel's title bar, or
   run **Claude Commit: Generate Commit Message (Claude)** from the command
   palette.
3. The extension reads `git diff --cached` (or `git diff` if nothing is
   staged) and pipes it to `claude -p` in headless mode.
4. Claude's response is written straight into the Source Control commit
   message box, ready to review and commit.

Nothing is sent anywhere by the extension itself — it shells out to the
`claude` CLI already installed and authenticated on your machine, the same
way you'd run it from a terminal.

The commit-message prompt also includes a diffstat and a sample of your
repo's own recent commit subjects, so the generated message matches your
existing style (Conventional Commits, emoji-prefixed, plain imperative,
whatever you already use) instead of always forcing one format, and calls
out the actual files/functions touched instead of vague phrasing.

## History & Chat

Run **Claude Commit: Open History & Chat (Claude)** (command palette, or
the speech-bubble icon next to the sparkle in the Source Control title
bar) for a panel with two tabs:

- **History** — browse and search (`git log --grep`) past commits; expand
  one to see its full message and changed files, with a "View diff" link
  per file that opens VS Code's own diff editor.
- **Chat** — ask questions about the repo's history ("why did we remove
  X", "what changed in `foo.ts` recently"). This runs the real Claude Code
  CLI with tool access restricted to read-only git/file commands (`git
  log`/`show`/`diff`/`blame`, `Read`/`Grep`/`Glob`), so it can actually dig
  through history to answer — but it cannot write, edit, or commit
  anything, no matter what's asked of it.

## Requirements

- The [Claude Code CLI](https://docs.claude.com/en/docs/claude-code) must be
  installed and authenticated (`claude` on your `PATH`, or point
  `claudeCommit.cliPath` at its full path).
- Git, and a workspace with at least one Git repository open.

## Usage

- **Source Control panel** → sparkle icon in the title bar, or right-click
  the repository entry → **Generate Commit Message (Claude)**.
- **Command palette** → `Claude Commit: Generate Commit Message (Claude)`.
- With multiple repositories open, you'll be prompted to pick one unless
  you triggered the command from a specific repository's panel.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `claudeCommit.cliPath` | `"claude"` | Path to the Claude Code CLI executable. |
| `claudeCommit.model` | `""` | Optional model passed via `--model`. Empty uses the CLI's default. |
| `claudeCommit.extraInstructions` | `""` | Extra text appended to the prompt — house style, ticket-number conventions, etc. |
| `claudeCommit.maxDiffChars` | `20000` | Diff is truncated to this many characters before being sent to Claude. |
| `claudeCommit.timeoutSeconds` | `60` | How long to wait for the CLI before giving up. Chat turns use double this (min 120s), since agentic exploration takes longer than a single-shot commit message. |

## Development

```bash
npm install
npm run watch
```

Then press `F5` in VS Code to launch an Extension Development Host with the
extension loaded.

To build a installable package:

```bash
npm run package   # produces claude-commit-0.2.0.vsix
```

Install the `.vsix` via VS Code / Cursor / Antigravity's
**Extensions: Install from VSIX...** command. To publish it to the VS Code
Marketplace / Open VSX so others can install it directly, see
[`PUBLISHING.md`](PUBLISHING.md). See [`CLAUDE.md`](CLAUDE.md) for a map of
the codebase if you're working on the extension itself.

## How it talks to Claude

The extension never talks to any API directly.

For commit messages, it spawns:

```bash
claude -p "<instructions>" --output-format text
```

with the diff piped in over stdin (so there's no argument-length limit on
large diffs), and takes the CLI's stdout as the commit message verbatim
(after stripping an accidental wrapping code fence or quotes).

For chat, it spawns:

```bash
claude -p "<question>" --output-format json \
  --allowedTools "Bash(git log:*)" "Bash(git show:*)" "Bash(git diff:*)" "Bash(git blame:*)" "Bash(git status:*)" Read Grep Glob \
  [--resume <session_id>]
```

reading `.result` for the answer and `.session_id` to keep the conversation
going across turns without resending the whole transcript each time.

## Known limitations

- Only tested in stock VS Code; Cursor/Antigravity compatibility relies on
  those forks continuing to ship the same `vscode.git` extension surface
  and standard `.vsix` install flow — verify in your target editor before
  relying on it.
- The generated message always replaces whatever is currently in the commit
  message box.
- Only one History & Chat panel is open at a time; reopening it resets the
  History tab's search/pagination. Chat history isn't persisted across VS
  Code restarts.
- History search matches commit messages (`git log --grep`), not diff
  content.
