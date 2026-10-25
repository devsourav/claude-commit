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

## Team Pool (shared memory)

Click the library icon in the editor title bar (next to the Claude Code
icon) or run **Claude Commit: Open Team Pool (Claude)**. It opens beside
the editor with three tabs:

- **Chat** — laid out like the Claude Code panel:
  - **Turn timeline:** a status dot for each step, expandable tool rows
    with output, `+N −M` on edits, todo checklists, and a live "✻
    Thinking… (12s · esc to interrupt)" status line.
  - **Edits and commands** behind a numbered permission prompt (1 Yes ·
    2 Yes for this session · 3 No, or type what to do instead), with
    **Open diff**.
  - **Modes:** Ask before edits, Edit automatically, Plan mode and Auto,
    cycled with **Shift+Tab**, plus Read-only from the mode menu.
  - **Composer:** `+` attaches files and images (or paste/drop
    screenshots), `/` lists slash commands (Claude Code's own `/compact`,
    `/context`, skills and custom commands, plus `/clear`, `/history`,
    `/pool`, `/save`), `@` autocompletes files, **Alt+Shift+K** inserts
    `@file#L10-20`, and your editor selection is attached automatically.
    You can also queue messages while Claude is working.
  - **Model and effort pill**, an idle timer with a prompt-cache-expired
    notice, conversation **history**, and new chat.
  - **Mic:** starts your OS dictation (Fn twice on macOS, Win+H on
    Windows).
  - **Keys:** Esc interrupts a turn or returns focus to the editor;
    **Ctrl+Esc** (macOS) or **Ctrl+Alt+Esc** focuses the chat.
  - **Save to pool** on any answer keeps it for the team.
  - A **safety check** runs before every edit and command, in every mode.
    It blocks edits outside the repo or inside `.git/`, edits that write
    credentials, invalid JSON, and destructive commands like force-push or
    `curl | sh`. Sensitive files (`.env`, keys, CI workflows, lockfiles)
    and big rewrites always ask first, even in *Edit automatically* mode.
- **Pool** — every entry grouped by module, with its kind, release and
  author. Click one to open it, **Ask** to chat about that module.
- **Add** — contribute a **Note**, a **Swagger/OpenAPI** JSON (parsed
  locally into an endpoint and schema reference, no model call),
  **Documents** (md/txt/pdf/images, distilled by Claude), **Links** (Claude
  share links, docs pages), or **Figma** frame links (read through the
  Figma MCP server). Generated entries are editable before saving.

You can also select text in any editor, right-click, and pick **Save
Selection to Team Pool**.

The pool is plain markdown in the repo under `.claude-pool/`, so anyone
with repo access gets it on `git pull` and shares by committing and
pushing. There's no server. Linking it from `CLAUDE.md` (one click in the
Pool tab) adds `@.claude-pool/index.md`, so **every teammate's own Claude
Code session** loads the index automatically and reads entries on
demand. That covers the CLI, the official IDE panel, and anything else
that reads CLAUDE.md. Backend contracts and frontend design specs stop
living in screenshots and chat messages, and a long session that has lost
context can always re-read the source of truth.

```
.claude-pool/
  index.md                  generated, loaded via CLAUDE.md
  modules/<module>/<entry>.md
  sources/<module>/...      original swagger.json / docs
```

Figma import needs the Figma MCP server connected to your `claude` CLI
(the claude.ai Figma connector, or a local server named `figma`).

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
| `claudeCommit.pool.figmaTools` | Figma read tools | Figma MCP tools the Team Pool may call when importing frames. Read-only tools only by default. |
| `claudeCommit.pool.chatTools` | `[]` (lean default) | Built-in tools the Team Pool chat loads in edit modes. Each extra tool adds tokens to every turn. |
| `claudeCommit.pool.autoCompactTokens` | `100000` | Compact a Team Pool conversation (`/compact`) after a turn once its context passes this size. Each step re-sends the whole context, so this keeps long sessions cheap. `0` disables it. |
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
